/**
 * Proceso de utilidad de conversión (Electron `utilityProcess`).
 *
 * Aísla el trabajo pesado del proceso principal: si una biblioteca nativa fallase con un archivo
 * malicioso o dañado, solo se cerraría este proceso y la aplicación seguiría funcionando.
 * Se comunica con el proceso principal mediante `process.parentPort`.
 */
import os from 'node:os';
import { runJob, type JobSpec } from './engine';
import { toConversionError } from './errors';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  throw new Error('worker.ts debe ejecutarse como proceso de utilidad de Electron.');
}

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // No es crítico.
}

const active = new Map<string, AbortController>();

const send = (message: WorkerResponse): void => parentPort.postMessage(message);

async function handleRun(spec: JobSpec): Promise<void> {
  const controller = new AbortController();
  active.set(spec.id, controller);
  let lastSent = 0;
  try {
    const result = await runJob(
      spec,
      (update) => {
        // Limita la frecuencia de mensajes: la interfaz interpola entre actualizaciones.
        const now = Date.now();
        if (now - lastSent < 80 && update.fraction !== 1 && update.fraction !== null) return;
        lastSent = now;
        send({ type: 'progress', jobId: spec.id, update });
      },
      controller.signal,
    );
    send({ type: 'done', jobId: spec.id, result });
  } catch (err) {
    const e = toConversionError(err);
    send({ type: 'failed', jobId: spec.id, code: e.code, message: e.message, detail: e.detail ?? (err as Error)?.stack });
  } finally {
    active.delete(spec.id);
  }
}

parentPort.on('message', (event) => {
  const message = event.data as WorkerRequest;
  switch (message?.type) {
    case 'run':
      void handleRun(message.spec);
      break;
    case 'cancel':
      active.get(message.jobId)?.abort();
      break;
    case 'ping':
      send({ type: 'pong' });
      break;
    case 'selftest':
      void selfTest();
      break;
    default:
      break;
  }
});

/** Mensaje con el detalle técnico (para el registro de diagnóstico). */
function describe(err: unknown): string {
  const e = err as { message?: string; detail?: string };
  return e?.detail ? `${e.message ?? ''} (${e.detail})` : (e?.message ?? String(err));
}

/** Comprueba que los motores cargan correctamente (sharp, pdf.js y su lienzo) e informa de cuáles se usan. */
async function selfTest(): Promise<void> {
  const report: { image: boolean; pdf: boolean; errors: string[]; details: string } = { image: false, pdf: false, errors: [], details: '' };
  const details: string[] = [];
  try {
    const { loadSharp, sharpBackend } = await import('./adapters/image');
    const sharp = await loadSharp();
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    report.image = true;
    details.push(`sharp ${sharpBackend()}, libvips ${sharp.versions.vips}`);
  } catch (err) {
    report.errors.push(`sharp: ${describe(err)}`);
  }
  try {
    const { loadPdfjs } = await import('./adapters/pdf');
    const { pdfjs } = await loadPdfjs();
    report.pdf = true;
    details.push(`pdf.js ${pdfjs.version}`);
  } catch (err) {
    report.errors.push(`pdf.js: ${describe(err)}`);
  }
  report.details = details.join(', ');
  send({ type: 'selftest', ...report });
}

send({ type: 'ready', pid: process.pid });
