/**
 * Traduce el estado de un trabajo al contenido de la notificación (sin dependencias de Electron),
 * en el idioma de la interfaz.
 */
import { DEFAULT_LANGUAGE, formatBytes, messages, type Language, type Messages } from '../../src/i18n';
import type { IconId } from '../../src/types/formats';
import type { ToastAction, ToastItem, ToastStatus } from '../../src/types/ipc';
import type { JobOutput } from '../conversion/engine';
import { FORMATS } from '../conversion/formats';
import { OFFICE_APP_NAMES, officeAppFor } from '../conversion/registry';
import type { Job } from './jobs';

/** Nombre del archivo de una ruta de Windows o POSIX. */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function sourceIsPdf(job: Job): boolean {
  return job.files.every((f) => f.format === 'pdf');
}

/** Extraer el audio de un vídeo (o de un GIF animado convertido a audio, que no se ofrece). */
function extractsAudio(job: Job): boolean {
  return FORMATS[job.target.format].category === 'audio' && job.files.some((f) => FORMATS[f.format].category === 'video');
}

function runningTitle(job: Job, m: Messages): string {
  const t = m.toast;
  if (job.cancelRequested) return t.cancelling;
  if (job.target.id === 'pdf-merge') return t.merging;
  if (job.target.id === 'shrink') return t.shrinking;
  if (job.target.id === 'pdf-split') return t.splitting;
  if (job.target.id === 'pdf-rotate') return t.rotating;
  if (sourceIsPdf(job) && FORMATS[job.target.format].category === 'image') return t.pagesTo(job.target.label);
  if (extractsAudio(job)) return t.extractingAudio(job.target.label);
  if (sourceIsPdf(job) && job.target.format === 'txt') return t.extractingText;
  return `${t.convertingTo(job.target.label)}${officeSuffix(job, m)}`;
}

/** « con Word» si todos los documentos los convierte la misma aplicación de Office. */
function officeSuffix(job: Job, m: Messages): string {
  const apps = new Set(job.files.map((f) => officeAppFor(f.format)));
  const [app] = apps;
  return apps.size === 1 && app ? m.toast.withApp(OFFICE_APP_NAMES[app]) : '';
}

function firstName(job: Job): string {
  return job.files[0]?.name ?? '';
}

/** «4,2 MB → 380 KB · −91 %»: lo que se ha ahorrado al reducir. */
function savings(outputs: readonly JobOutput[], language: Language): string | null {
  let before = 0;
  let after = 0;
  for (const o of outputs) {
    if (o.inputBytes === undefined || o.outputBytes === undefined) return null;
    before += o.inputBytes;
    after += o.outputBytes;
  }
  if (before <= 0) return null;
  const saved = Math.max(0, Math.round((1 - after / before) * 100));
  return `${formatBytes(before, language)} → ${formatBytes(after, language)} · −${messages(language).percent(saved)}`;
}

/** Porcentaje entero hacia abajo (nunca «100 %» antes de terminar). */
function percent(p: number | null, m: Messages): string {
  return p === null ? '' : ` · ${m.percent(Math.min(99, Math.floor(p * 100)))}`;
}

/** Cantidad procesada: archivos del lote o, en un solo archivo, sus páginas o imágenes. */
function runningMeta(job: Job, m: Messages): string {
  const step = job.step;
  if (job.total <= 1 && step && step.total > 1) return `${m.toast.partsOf(step.done, step.total, step.unit)}${percent(job.progress, m)}`;
  return `${m.toast.processed(job.completed, job.total)}${percent(job.progress, m)}`;
}

export function jobToToast(job: Job, language: Language = DEFAULT_LANGUAGE): ToastItem {
  const m = messages(language);
  const t = m.toast;
  let status: ToastStatus;
  let title: string;
  let detail: string;
  let icon: IconId = job.target.icon;
  let actions: ToastAction[];
  let progress: number | null = job.progress;
  let meta: string | null = null;

  switch (job.state) {
    case 'queued':
      status = 'running';
      title = t.queued(job.target.label);
      detail = job.files.length > 1 ? m.files(job.files.length) : firstName(job);
      meta = t.processed(0, job.total);
      actions = ['cancel'];
      progress = null;
      break;
    case 'running': {
      status = 'running';
      title = runningTitle(job, m);
      if (job.target.id === 'pdf-merge') detail = `${firstName(job)}${job.files.length > 1 ? t.andMore(job.files.length - 1) : ''}`;
      else if (job.total > 1) detail = job.files[Math.min(job.currentIndex, job.files.length - 1)]?.name ?? '';
      else detail = firstName(job);
      meta = runningMeta(job, m);
      actions = job.cancelRequested ? [] : ['cancel'];
      break;
    }
    case 'done': {
      const result = job.result;
      const outputs = result?.outputs ?? [];
      const failures = result?.failures ?? [];
      const skipped = result?.skipped ?? [];
      progress = 1;
      if (outputs.length === 0) {
        status = 'info';
        icon = 'info';
        if (job.target.id === 'pdf-split' && skipped.length > 0) {
          title = t.nothingToSplit;
          detail = skipped.length === 1 ? t.onePage(baseName(skipped[0]?.source ?? '')) : t.onePageMany(skipped.length);
        } else if (job.target.id === 'shrink' && skipped.length > 0) {
          title = t.alreadySmall(skipped.length);
          detail = skipped.length === 1 ? t.wouldNotSave(baseName(skipped[0]?.source ?? '')) : t.wouldNotSaveMany(skipped.length);
        } else {
          title = t.nothingToConvert;
          detail = skipped.length > 0 ? t.alreadyIn(skipped.length, job.target.label) : t.noOutput;
        }
        actions = ['dismiss'];
        break;
      }
      if (failures.length > 0) {
        const failure = failures[0];
        status = 'error';
        icon = 'alert';
        title = t.converted(outputs.length, outputs.length + failures.length);
        detail = `${baseName(failure?.source ?? '')}: ${failure ? m.errors[failure.code] : ''}`;
        actions = ['retry', 'reveal', 'dismiss'];
        break;
      }
      status = 'done';
      icon = 'check';
      actions = ['reveal', 'dismiss'];
      meta = t.processed(job.total, job.total);
      const first = outputs[0];
      if (outputs.length === 1 && first) {
        title = t.saved;
        detail =
          first.kind === 'folder'
            ? `${baseName(first.output)} · ${m.pages(first.count)}`
            : job.target.id === 'pdf-merge'
              ? `${baseName(first.output)} · ${job.files.some((f) => f.format === 'pdf') ? m.files(first.count) : m.images(first.count)}`
              : baseName(first.output);
        // Un aviso sobre el resultado (p. ej. caracteres sustituidos) ocupa la línea de cantidad.
        if (first.note) meta = first.note;
      } else {
        title = t.savedMany(outputs.length);
        if (skipped.length === 0) detail = t.nextToOriginals;
        else if (job.target.id === 'shrink') detail = t.wasSmall(skipped.length);
        else if (job.target.id === 'pdf-split') detail = t.hadOnePage(skipped.length);
        else detail = t.wasAlreadyIn(skipped.length, job.target.label);
      }
      // Al reducir, lo importante es cuánto se ha ahorrado.
      if (job.target.id === 'shrink') meta = savings(outputs, language) ?? meta;
      break;
    }
    case 'failed':
      status = 'error';
      icon = 'alert';
      title = t.failed;
      detail = job.error ? m.errors[job.error.code] : t.unknownError;
      if (job.files.length === 1 && job.error?.code !== 'engine_unavailable') detail = `${firstName(job)}: ${detail}`;
      actions = ['retry', 'dismiss'];
      progress = null;
      break;
    case 'cancelled':
    default:
      status = 'cancelled';
      icon = 'close';
      title = t.cancelled;
      detail = job.files.length > 1 ? m.files(job.files.length) : firstName(job);
      meta = t.processed(job.completed, job.total);
      actions = ['dismiss'];
      progress = null;
      break;
  }
  return { id: job.id, status, title, detail, meta, progress, icon, actions };
}
