/**
 * Documentos de Office (Word, Excel, PowerPoint y OpenDocument) → PDF con el propio Microsoft Office.
 *
 * EFC no incluye ningún motor de documentos: si Office está instalado, le pide que exporte a PDF por
 * automatización (efc-office.ps1, un documento cada vez). Office trabaja oculto, con las macros
 * desactivadas, sin actualizar vínculos y con el documento abierto solo para lectura.
 *
 * Las conversiones con Office van de una en una aunque haya varios trabajos en marcha: PowerPoint solo
 * admite una instancia y así tampoco se acumulan varias copias de Office en memoria.
 */
import { spawn } from 'node:child_process';
import { ConversionError } from '../errors';
import type { OfficeApp } from '../registry';

/** Límite por documento: un diálogo oculto o un documento enorme no deben bloquear la cola. */
export const OFFICE_TIMEOUT_MS = 10 * 60_000;

/** Cómo lanzar el script de Office (rutas resueltas por el proceso principal). */
export interface OfficeRunner {
  powershell: string;
  script: string;
}

/** Línea JSON que escribe efc-office.ps1. */
export interface OfficeScriptEvent {
  event: 'started' | 'done' | 'error' | 'warning';
  pids?: unknown;
  stage?: string;
  hresult?: string | null;
  detail?: string;
}

export function parseOfficeEvent(line: string): OfficeScriptEvent | null {
  try {
    const data = JSON.parse(line) as OfficeScriptEvent;
    return data && typeof data === 'object' && ['started', 'done', 'error', 'warning'].includes(data.event) ? data : null;
  } catch {
    return null;
  }
}

/** Traduce el error que informa el script al código que verá el usuario. */
export function officeError(app: OfficeApp, event: Pick<OfficeScriptEvent, 'stage' | 'hresult' | 'detail'>): ConversionError {
  const detail = `${app} · ${event.stage ?? '?'} · ${event.hresult ?? 'sin código'} · ${event.detail ?? ''}`;
  switch (event.stage) {
    case 'start':
      return new ConversionError('office_start', detail);
    case 'empty':
      return new ConversionError('nothing_to_print', detail);
    case 'open':
      // Word: error 5408 (0x800A1520), «La contraseña es incorrecta». Excel y PowerPoint usan códigos
      // genéricos; sus DOCX/XLSX/PPTX cifrados ya se detectan antes de abrir Office.
      if (app === 'word' && event.hresult === '0x800A1520') return new ConversionError('doc_password', detail);
      return new ConversionError('office_open', detail);
    default:
      return new ConversionError('office_failed', detail);
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Ejecuta las tareas de Office de una en una, en orden de llegada. */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export interface OfficeExportOptions {
  signal: AbortSignal;
  timeoutMs?: number;
}

/** Exporta `input` a PDF en `output` con la aplicación de Office indicada. */
export function exportWithOffice(runner: OfficeRunner, app: OfficeApp, input: string, output: string, options: OfficeExportOptions): Promise<void> {
  return exclusive(() => runScript(runner, app, input, output, options));
}

function runScript(runner: OfficeRunner, app: OfficeApp, input: string, output: string, options: OfficeExportOptions): Promise<void> {
  const { signal, timeoutMs = OFFICE_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ConversionError('cancelled'));
      return;
    }
    // Las rutas van en variables de entorno: así no hay problemas de comillas ni de caracteres especiales.
    const child = spawn(
      runner.powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', runner.script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, EFC_OFFICE_APP: app, EFC_OFFICE_IN: input, EFC_OFFICE_OUT: output },
      },
    );
    /** Procesos de Office que abrió el script (nunca los que ya tenía abiertos el usuario). */
    let officePids: number[] = [];
    /** El script ya ha dicho qué Office abrió (antes de eso, cortarlo dejaría un Office huérfano). */
    let started = false;
    let outcome: OfficeScriptEvent | null = null;
    const warnings: string[] = [];
    let pending = '';
    let stderr = '';
    let stopped: 'timeout' | 'cancelled' | null = null;

    const onLine = (line: string): void => {
      const event = parseOfficeEvent(line);
      if (!event) return;
      if (event.event === 'started') {
        officePids = Array.isArray(event.pids) ? event.pids.filter((p): p is number => Number.isInteger(p) && (p as number) > 0) : [];
        started = true;
        if (stopped) terminate();
      } else if (event.event === 'warning') {
        warnings.push(`${event.stage ?? '?'}: ${event.detail ?? ''}`);
      } else if (event.event === 'done' || event.event === 'error') {
        outcome = event;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        onLine(pending.slice(0, newline).trim());
        pending = pending.slice(newline + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });

    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill();
      // Office sigue vivo aunque se cierre el script: se termina también la copia que abrió EFC.
      for (const pid of officePids) {
        try {
          process.kill(pid);
        } catch {
          // Ya había terminado.
        }
      }
    };
    /** Corta la conversión en cuanto se puede hacer sin dejar Office abierto. */
    const terminate = (): void => {
      if (officePids.length > 0 || stopped === 'timeout') kill();
      // Si no abrió ninguna copia propia, usa el PowerPoint que ya tenía abierto el usuario: se deja
      // terminar (son segundos) y se descarta el resultado, para no dejarle una presentación oculta.
    };
    let lateKill: NodeJS.Timeout | null = null;
    const stop = (why: 'timeout' | 'cancelled'): void => {
      if (stopped) return;
      stopped = why;
      if (started) terminate();
      // Office aún está arrancando: se espera a saber qué proceso es (como mucho 30 s).
      else lateKill = setTimeout(kill, 30_000);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = (): void => stop('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (): void => {
      clearTimeout(timer);
      if (lateKill) clearTimeout(lateKill);
      signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      finish();
      reject(new ConversionError('office_start', `No se pudo ejecutar PowerShell: ${err.message}`));
    });
    child.on('close', (code) => {
      finish();
      if (pending.trim()) onLine(pending.trim());
      const extra = warnings.length > 0 ? ` · avisos: ${warnings.join(' | ')}` : '';
      const result = outcome as OfficeScriptEvent | null;
      if (stopped === 'cancelled') reject(new ConversionError('cancelled'));
      else if (stopped === 'timeout') reject(new ConversionError('office_timeout', `Más de ${Math.round(timeoutMs / 1000)} s${extra}`));
      else if (result?.event === 'done' && code === 0) resolve();
      else if (result?.event === 'error') {
        const e = officeError(app, result);
        reject(new ConversionError(e.code, `${e.detail ?? ''}${extra}`));
      } else reject(new ConversionError('office_failed', `El script terminó con código ${code}: ${stderr.trim() || 'sin respuesta'}${extra}`));
    });
  });
}
