/**
 * Cola de trabajos de conversión: concurrencia limitada, sin duplicados, cancelación, reintento y
 * limpieza de temporales si el proceso de conversión se cierra inesperadamente.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Language } from '../../src/i18n';
import type { OfficeRunner } from '../conversion/adapters/office';
import type { JobResult, JobSpec, ProgressStep } from '../conversion/engine';
import type { ConversionErrorCode } from '../conversion/errors';
import { TEMP_PREFIX } from '../conversion/output-path';
import type { EngineCaps, TargetOption } from '../conversion/registry';
import type { ConversionSettings } from '../conversion/settings';
import type { SelectedFile } from '../windows/selection';
import { createLogger } from './logger';
import type { Point } from './placement';
import type { WorkerClient } from './worker-client';

const log = createLogger('trabajos');

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  key: string;
  target: TargetOption;
  files: SelectedFile[];
  state: JobState;
  /** Progreso global (0–1) o `null` si no es medible. */
  progress: number | null;
  completed: number;
  total: number;
  currentIndex: number;
  /** Páginas o imágenes procesadas del archivo en curso, si el motor las cuenta. */
  step: ProgressStep | null;
  result: JobResult | null;
  error: { code: ConversionErrorCode; message: string } | null;
  anchor: Point;
  cancelRequested: boolean;
}

export interface JobManagerOptions {
  worker: WorkerClient;
  maxConcurrent(): number;
  settings(): ConversionSettings;
  caps(): EngineCaps;
  /** Fuente incluida para TXT → PDF. */
  fontPath(): string | null;
  /** Idioma de la interfaz: nombres de lo que se crea («_reducido» o «_shrunk»…). */
  language(): Language;
  /** Cómo lanzar el script de exportación de Office (si no hay Office, no se usa). */
  officeRunner(): OfficeRunner | null;
  onChange(job: Job): void;
}

function jobKey(target: string, files: readonly SelectedFile[]): string {
  return `${target}|${files.map((f) => f.path.toLowerCase()).sort().join('|')}`;
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private active = 0;

  constructor(private readonly options: JobManagerOptions) {}

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Encola una conversión. Si ya hay una idéntica en marcha devuelve esa (no se duplica el trabajo). */
  enqueue(files: SelectedFile[], target: TargetOption, anchor: Point): { job: Job; duplicate: boolean } {
    const key = jobKey(target.id, files);
    for (const existing of this.jobs.values()) {
      if (existing.key === key && (existing.state === 'queued' || existing.state === 'running')) {
        return { job: existing, duplicate: true };
      }
    }
    const job: Job = {
      id: randomBytes(6).toString('hex'),
      key,
      target,
      files,
      state: 'queued',
      progress: null,
      completed: 0,
      total: target.id === 'pdf-merge' ? 1 : files.length,
      currentIndex: 0,
      step: null,
      result: null,
      error: null,
      anchor,
      cancelRequested: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.options.onChange(job);
    this.pump();
    return { job, duplicate: false };
  }

  private pump(): void {
    while (this.active < this.options.maxConcurrent() && this.queue.length > 0) {
      const id = this.queue.shift() as string;
      const job = this.jobs.get(id);
      if (!job || job.state !== 'queued') continue;
      this.start(job);
    }
  }

  private start(job: Job): void {
    this.active++;
    job.state = 'running';
    this.options.onChange(job);
    const caps = this.options.caps();
    const office = caps.office ?? null;
    const runner = office ? this.options.officeRunner() : null;
    const spec: JobSpec = {
      id: job.id,
      target: job.target.id,
      files: job.files.map((f) => ({ path: f.path, format: f.format })),
      settings: this.options.settings(),
      ffmpeg: caps.ffmpeg ? { path: caps.ffmpeg.path, version: caps.ffmpeg.version, encoders: [...caps.ffmpeg.encoders] } : null,
      fontPath: this.options.fontPath(),
      language: this.options.language(),
      office: office && runner ? { ...runner, apps: office } : null,
    };
    log.info(`Inicio ${job.id}: ${job.files.length} archivo(s) → ${job.target.id}`);
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      this.active--;
      this.pump();
    };

    void this.options.worker.run(spec, {
      onProgress: (update) => {
        if (job.state !== 'running') return;
        job.progress = update.overall;
        job.completed = update.completed;
        job.currentIndex = update.fileIndex;
        job.step = update.step ?? null;
        this.options.onChange(job);
      },
      onDone: (result) => {
        job.result = result;
        job.step = null;
        job.progress = 1;
        job.completed = job.total;
        if (result.cancelled) job.state = 'cancelled';
        else if (result.outputs.length === 0 && result.failures.length > 0) {
          job.state = 'failed';
          const first = result.failures[0];
          job.error = first ? { code: first.code, message: first.message } : { code: 'unknown', message: 'Error desconocido' };
        } else job.state = 'done';
        for (const f of result.failures) log.warn(`Fallo en ${f.source}: ${f.code} ${f.detail ?? ''}`);
        log.info(`Fin ${job.id}: ${job.state} (${result.outputs.length} salida(s), ${result.failures.length} error(es), ${result.skipped.length} omitido(s))`);
        finish();
        this.options.onChange(job);
      },
      onFailed: (code, message, detail) => {
        job.state = code === 'cancelled' ? 'cancelled' : 'failed';
        job.error = { code, message };
        log.error(`Trabajo ${job.id} fallido: ${code} ${detail ?? ''}`);
        void this.cleanupTemps(job);
        finish();
        this.options.onChange(job);
      },
    });
  }

  /** Elimina temporales de un trabajo interrumpido (p. ej. si el proceso de conversión se cerró). */
  private async cleanupTemps(job: Job): Promise<void> {
    const prefix = `${TEMP_PREFIX}${job.id}-`;
    // Office exporta en la carpeta temporal del sistema.
    const dirs = new Set([...job.files.map((f) => path.dirname(f.path)), os.tmpdir()]);
    for (const dir of dirs) {
      try {
        for (const name of await fs.readdir(dir)) {
          if (name.startsWith(prefix)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
        }
      } catch {
        // Carpeta no accesible: no es crítico.
      }
    }
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.state === 'queued') {
      job.state = 'cancelled';
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      this.options.onChange(job);
    } else if (job.state === 'running' && !job.cancelRequested) {
      job.cancelRequested = true;
      this.options.worker.cancel(id);
      this.options.onChange(job);
    }
  }

  /** Reintenta los archivos que fallaron. Devuelve el nuevo trabajo, si lo hay. */
  retry(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job || (job.state !== 'failed' && job.state !== 'done' && job.state !== 'cancelled')) return null;
    let files = job.files;
    if (job.result && job.result.failures.length > 0 && job.target.id !== 'pdf-merge') {
      const failed = new Set(job.result.failures.map((f) => f.source));
      files = job.files.filter((f) => failed.has(f.path));
    }
    if (files.length === 0) return null;
    this.forget(id);
    return this.enqueue(files, job.target, job.anchor).job;
  }

  forget(id: string): void {
    const job = this.jobs.get(id);
    if (job && (job.state === 'queued' || job.state === 'running')) return;
    this.jobs.delete(id);
  }

  hasActive(): boolean {
    return [...this.jobs.values()].some((j) => j.state === 'queued' || j.state === 'running');
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) this.cancel(job.id);
  }
}
