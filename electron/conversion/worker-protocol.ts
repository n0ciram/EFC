/** Mensajes entre el proceso principal y el proceso de conversión. */
import type { JobResult, JobSpec, ProgressUpdate } from './engine';
import type { ConversionErrorCode } from './errors';

export type WorkerRequest =
  | { type: 'run'; spec: JobSpec }
  | { type: 'cancel'; jobId: string }
  | { type: 'ping' }
  | { type: 'selftest' };

export type WorkerResponse =
  | { type: 'ready'; pid: number }
  | { type: 'pong' }
  | { type: 'progress'; jobId: string; update: ProgressUpdate }
  | { type: 'done'; jobId: string; result: JobResult }
  | { type: 'failed'; jobId: string; code: ConversionErrorCode; message: string; detail?: string }
  | { type: 'selftest'; image: boolean; pdf: boolean; errors: string[]; details?: string };
