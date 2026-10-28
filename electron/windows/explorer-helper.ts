/**
 * Cliente del ayudante del Explorador.
 *
 * Implementación principal: `efc-helper.exe`, un ejecutable nativo pequeño (Win32 + COM, sin .NET ni
 * PowerShell) que acompaña a EFC. Alternativa automática si no puede iniciarse (falta, bloqueado por
 * una directiva…): PowerShell cargando el código C# equivalente (`EfcHelper.cs`).
 *
 * El proceso se inicia una vez al arrancar EFC y queda bloqueado leyendo su entrada estándar, por lo
 * que no consume CPU mientras no se usa. Cada pulsación del atajo envía una petición y recibe una
 * respuesta JSON en pocos milisegundos. Si una petición no responde a tiempo (por ejemplo, porque el
 * Explorador está colgado), el ayudante se reinicia para no bloquear las siguientes.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createLogger } from '../main/logger';

const log = createLogger('explorador');

export interface HelperRect {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface HelperItem {
  path: string;
  name: string;
  isFolder: boolean;
  isFileSystem: boolean;
  isLink: boolean;
}

export interface ExplorerSelection {
  ok: true;
  kind: 'explorer';
  hwnd: number;
  pid: number;
  tabs: number;
  tabMatched: boolean;
  folder: string | null;
  items: HelperItem[];
  truncated: boolean;
  cursor: { x: number; y: number } | null;
  window: HelperRect;
  item: HelperRect | null;
  ms: number;
}

export type QueryResult =
  | ExplorerSelection
  | { ok: true; kind: 'none' | 'desktop' | 'other'; class?: string; process?: string }
  | { ok: false; error: string; detail?: string; candidates?: number };

/** Zona de la pantalla capturada (píxeles BGRA de arriba abajo, codificados en base64). */
export type CaptureResult = { ok: true; width: number; height: number; format: 'bgra'; data: string } | { ok: false; error: string };

export interface HelperPaths {
  /** Ayudante nativo. */
  exe: string;
  /** Alternativa: script de PowerShell que compila en memoria `source`. */
  script: string;
  source: string;
  powershell: string;
}

type Command = 'query' | 'capture' | 'passthrough' | 'focus' | 'ping';

interface Pending {
  command: Command;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export type HelperMode = 'native' | 'powershell';

export class ExplorerHelper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private failures: number[] = [];
  private disposed = false;
  private nativeBroken = false;
  mode: HelperMode | null = null;
  /** El ayudante en uso sabe capturar la pantalla (solo el nativo). */
  canCapture = false;

  constructor(private readonly paths: HelperPaths) {}

  /** Inicia el proceso si no está en marcha. Resuelve cuando el ayudante está listo. */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Ayudante cerrado'));
    this.ready ??= this.launch().catch((err: unknown) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private launch(): Promise<void> {
    const useNative = !this.nativeBroken && existsSync(this.paths.exe);
    const mode: HelperMode = useNative ? 'native' : 'powershell';
    if (!useNative && !existsSync(this.paths.script)) {
      return Promise.reject(new Error('No se encontró el ayudante del Explorador'));
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = useNative
        ? spawn(this.paths.exe, [], { windowsHide: true, stdio: 'pipe' })
        : spawn(
            this.paths.powershell,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.paths.script, '-SourcePath', this.paths.source],
            { windowsHide: true, stdio: 'pipe' },
          );
    } catch (err) {
      if (useNative) this.nativeBroken = true;
      return Promise.reject(err);
    }
    this.child = child;
    this.mode = mode;
    this.canCapture = false;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    return new Promise<void>((resolve, reject) => {
      let started = false;
      const timeout = setTimeout(
        () => {
          log.error(`El ayudante (${mode}) no respondió a tiempo al iniciarse`);
          if (mode === 'native') this.nativeBroken = true;
          child.kill();
          reject(new Error('El ayudante del Explorador no respondió'));
        },
        mode === 'native' ? 8000 : 30000,
      );

      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        let index: number;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, index).trim();
          this.buffer = this.buffer.slice(index + 1);
          if (!line) continue;
          let message: { type?: string; id?: number; result?: unknown; impl?: string; capture?: boolean };
          try {
            message = JSON.parse(line) as typeof message;
          } catch {
            log.warn('Línea no válida del ayudante', line.slice(0, 200));
            continue;
          }
          if (message.type === 'ready') {
            started = true;
            clearTimeout(timeout);
            this.canCapture = message.capture === true;
            log.info(`Ayudante del Explorador listo (${mode}${message.impl ? `/${message.impl}` : ''})`);
            resolve();
            continue;
          }
          if (typeof message.id === 'number') {
            const p = this.pending.get(message.id);
            if (p) {
              this.pending.delete(message.id);
              clearTimeout(p.timer);
              p.resolve(message.result);
            }
          }
        }
      });
      child.stderr.on('data', (chunk: string) => log.warn(`stderr del ayudante: ${chunk.trim().slice(0, 500)}`));
      child.on('error', (err) => {
        log.error(`No se pudo iniciar el ayudante (${mode})`, err);
        if (mode === 'native') this.nativeBroken = true;
        if (!started) {
          clearTimeout(timeout);
          reject(err);
        }
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('El ayudante se cerró'));
          this.pending.delete(id);
        }
        if (this.disposed) return;
        log.warn(`El ayudante (${mode}) terminó (código ${code}, señal ${signal})`);
        if (!started) {
          clearTimeout(timeout);
          if (mode === 'native') this.nativeBroken = true;
          reject(new Error(`El ayudante terminó al iniciarse (código ${code})`));
          return;
        }
        this.scheduleRestart();
      });
    });
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 10 * 60_000);
    this.failures.push(now);
    if (this.failures.length > 5) {
      log.error('El ayudante falla repetidamente; se reintentará con la próxima pulsación del atajo.');
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** (this.failures.length - 1));
    setTimeout(() => {
      if (!this.disposed && !this.child) this.start().catch((err: unknown) => log.error('Reinicio del ayudante fallido', err));
    }, delay).unref();
  }

  /** Envía una petición. Los argumentos solo pueden ser enteros (nunca texto libre). */
  async request<T>(command: Command, args: number[] = [], timeoutMs = 2500): Promise<T> {
    for (const a of args) {
      if (!Number.isSafeInteger(a)) throw new Error('Argumento no válido para el ayudante');
    }
    await this.start();
    const child = this.child;
    if (!child) throw new Error('Ayudante no disponible');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tiempo de espera agotado (${command})`));
        // Un ayudante que no responde (p. ej. el Explorador está colgado) se reinicia para que las
        // siguientes pulsaciones no esperen detrás de esta.
        if (this.child === child) {
          log.warn(`El ayudante no respondió a «${command}» en ${timeoutMs} ms; se reinicia`);
          child.kill();
        }
      }, timeoutMs);
      this.pending.set(id, { command, resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(`${[command, id, ...args].join(' ')}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Captura una zona de la pantalla en píxeles físicos, reducida a `percent` %. Devuelve `null` si
   * el ayudante no sabe capturar o la captura falla (la interfaz usará un cristal más opaco).
   */
  async capture(rect: { x: number; y: number; width: number; height: number }, percent: number, timeoutMs = 400): Promise<{ width: number; height: number; bgra: Buffer } | null> {
    if (!this.canCapture) return null;
    const args = [rect.x, rect.y, rect.width, rect.height, percent].map((v) => Math.round(v));
    try {
      const result = await this.request<CaptureResult>('capture', args, timeoutMs);
      if (!result.ok) return null;
      const bgra = Buffer.from(result.data, 'base64');
      if (bgra.length !== result.width * result.height * 4) return null;
      return { width: result.width, height: result.height, bgra };
    } catch (err) {
      log.debug('Captura no disponible', err);
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.write('exit\n');
      child.stdin.end();
    } catch {
      // ya cerrado
    }
    setTimeout(() => child.kill(), 600).unref();
  }
}
