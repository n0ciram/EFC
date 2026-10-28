/**
 * Proceso de conversión aislado (Electron `utilityProcess`), iniciado bajo demanda y cerrado tras
 * un rato sin trabajo para liberar memoria.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import type { JobResult, JobSpec, ProgressUpdate } from '../conversion/engine';
import type { ConversionErrorCode } from '../conversion/errors';
import type { WorkerRequest, WorkerResponse } from '../conversion/worker-protocol';
import { createLogger } from './logger';

const log = createLogger('conversión');
const IDLE_SHUTDOWN_MS = 45_000;

export interface RunHandlers {
  onProgress(update: ProgressUpdate): void;
  onDone(result: JobResult): void;
  onFailed(code: ConversionErrorCode, message: string, detail?: string): void;
}

export interface SelfTestReport {
  image: boolean;
  pdf: boolean;
  errors: string[];
  /** Motores en uso, p. ej. «sharp WebAssembly, libvips 8.18.6, pdf.js 6.2.108». */
  details?: string;
}

export class WorkerClient {
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly running = new Map<string, RunHandlers>();
  private idleTimer: NodeJS.Timeout | null = null;
  private selfTestWaiters: ((report: SelfTestReport) => void)[] = [];

  constructor(private readonly workerPath: string) {}

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let child: UtilityProcess;
      try {
        child = utilityProcess.fork(this.workerPath, [], { serviceName: 'EFC Conversion', stdio: 'pipe' });
      } catch (err) {
        this.ready = null;
        reject(err);
        return;
      }
      this.child = child;
      const startTimer = setTimeout(() => {
        log.error('El proceso de conversión no respondió al iniciarse');
        child.kill();
      }, 15_000);
      child.stdout?.on('data', (data: Buffer) => log.debug(`worker: ${data.toString().trim()}`));
      child.stderr?.on('data', (data: Buffer) => log.warn(`worker stderr: ${data.toString().trim().slice(0, 1000)}`));
      child.on('message', (message: WorkerResponse) => {
        if (message.type === 'ready') {
          clearTimeout(startTimer);
          log.info(`Proceso de conversión listo (pid ${message.pid})`);
          resolve();
          return;
        }
        this.handle(message);
      });
      child.on('exit', (code) => {
        clearTimeout(startTimer);
        const wasReady = this.ready;
        this.child = null;
        this.ready = null;
        if (this.running.size > 0) {
          log.error(`El proceso de conversión terminó inesperadamente (código ${code})`);
          for (const [, handlers] of this.running) {
            handlers.onFailed('unknown', 'El proceso de conversión se cerró inesperadamente.', `código ${code}`);
          }
          this.running.clear();
        } else {
          log.debug(`Proceso de conversión cerrado (código ${code})`);
        }
        if (wasReady) reject(new Error(`El proceso de conversión terminó (código ${code})`));
        for (const waiter of this.selfTestWaiters.splice(0)) waiter({ image: false, pdf: false, errors: [`proceso cerrado (${code})`] });
      });
    });
    // Evita rechazos no gestionados si nadie espera en ese momento.
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private handle(message: WorkerResponse): void {
    switch (message.type) {
      case 'progress':
        this.running.get(message.jobId)?.onProgress(message.update);
        break;
      case 'done': {
        const handlers = this.running.get(message.jobId);
        this.running.delete(message.jobId);
        handlers?.onDone(message.result);
        this.scheduleIdle();
        break;
      }
      case 'failed': {
        const handlers = this.running.get(message.jobId);
        this.running.delete(message.jobId);
        handlers?.onFailed(message.code, message.message, message.detail);
        this.scheduleIdle();
        break;
      }
      case 'selftest':
        for (const waiter of this.selfTestWaiters.splice(0)) waiter({ image: message.image, pdf: message.pdf, errors: message.errors, details: message.details });
        this.scheduleIdle();
        break;
      default:
        break;
    }
  }

  private post(message: WorkerRequest): void {
    this.child?.postMessage(message);
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.running.size === 0 && this.selfTestWaiters.length === 0 && this.child) {
        log.debug('Cerrando el proceso de conversión por inactividad');
        this.child.kill();
      }
    }, IDLE_SHUTDOWN_MS);
  }

  async run(spec: JobSpec, handlers: RunHandlers): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.ensure();
    } catch (err) {
      handlers.onFailed('engine_unavailable', 'No se pudo iniciar el proceso de conversión.', (err as Error).message);
      return;
    }
    this.running.set(spec.id, handlers);
    this.post({ type: 'run', spec });
  }

  cancel(jobId: string): void {
    if (this.running.has(jobId)) this.post({ type: 'cancel', jobId });
  }

  async selfTest(): Promise<SelfTestReport> {
    try {
      await this.ensure();
    } catch (err) {
      return { image: false, pdf: false, errors: [(err as Error).message] };
    }
    return new Promise<SelfTestReport>((resolve) => {
      this.selfTestWaiters.push(resolve);
      this.post({ type: 'selftest' });
    });
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const jobId of this.running.keys()) this.post({ type: 'cancel', jobId });
    const child = this.child;
    if (child) setTimeout(() => child.kill(), 1500).unref();
  }
}
