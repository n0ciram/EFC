/**
 * Motor de conversión: ejecuta un trabajo (uno o varios archivos hacia un destino) de principio a fin.
 *
 * Garantías:
 * - El archivo original nunca se modifica.
 * - Todo se escribe primero con un nombre temporal en la misma carpeta y solo se publica con su nombre
 *   definitivo tras verificarlo; los errores y cancelaciones eliminan los temporales.
 * - Un archivo que falla no detiene el resto del lote.
 *
 * Este módulo no depende de Electron: se ejecuta en un proceso de utilidad y también en las pruebas.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FormatId, TargetId } from '../../src/types/formats';
import { encodeImage, loadSharp, openImage, shrinkImage, verifyEncoded, type OpenedImage } from './adapters/image';
import { addImagePage, createPdf, savePdf, verifyPdf } from './adapters/image-pdf';
import { extractPageText, openPdf, openPdfData, renderPage } from './adapters/pdf';
import { planConversion, planShrink, probeMedia, runFfmpeg } from './adapters/ffmpeg';
import { readText, textToDocx, textToPdf, verifyDocx } from './adapters/text';
import { appendPdf, extractPage, loadEditablePdf, rotateAllPages, savePdfBytes, shrinkPdfImages } from './adapters/pdf-tools';
import { exportWithOffice, type OfficeRunner } from './adapters/office';
import { isEncryptedOoxml } from './detect';
import { readHeader, readWhole } from './io';
import { ConversionError, toConversionError, type ConversionErrorCode } from './errors';
import { FORMATS, outputExtension } from './formats';
import { validateSource } from './io';
import { pageFileName, publishFile, publishFolder, removeQuietly, splitFileName, tempPathFor } from './output-path';
import { messages, type Language, type Messages } from '../../src/i18n';
import { engineFor, officeAppFor, type EngineCaps, type EngineKind, type FfmpegCaps, type OfficeApps } from './registry';
import type { ConversionSettings } from './settings';

export interface JobFile {
  path: string;
  format: FormatId;
}

export interface JobSpec {
  id: string;
  target: TargetId;
  files: JobFile[];
  settings: ConversionSettings;
  ffmpeg: { path: string; version: string; encoders: string[] } | null;
  /** Fuente incluida para escribir texto en PDF (DejaVu Sans Mono). */
  fontPath?: string | null;
  /** Idioma de la interfaz: decide los nombres de lo que se crea («_reducido» o «_shrunk»…). */
  language?: Language;
  /** Office instalado y cómo lanzar su script de exportación (solo en Windows). */
  office?: (OfficeRunner & { apps: OfficeApps }) | null;
}

/** Partes contables del archivo en curso (páginas de un PDF, imágenes que se unen en un PDF). */
export interface ProgressStep {
  done: number;
  total: number;
  unit: 'page' | 'image' | 'file';
}

export interface ProgressUpdate {
  /** Índice del archivo en curso (desde 0). */
  fileIndex: number;
  fileCount: number;
  /** Archivos terminados (con éxito o error). */
  completed: number;
  /** Progreso del archivo actual (0–1) o `null` si el motor no lo puede medir. */
  fraction: number | null;
  /** Progreso global (0–1) o `null` si no hay una cifra fiable. */
  overall: number | null;
  /** Partes del archivo en curso ya procesadas, si el motor las cuenta. */
  step: ProgressStep | null;
}

export interface JobOutput {
  source: string;
  output: string;
  kind: 'file' | 'folder';
  /** Número de archivos producidos (páginas, en el caso de una carpeta). */
  count: number;
  /** Aviso sobre el resultado que el usuario debe conocer (p. ej. caracteres sustituidos). */
  note?: string;
  /** «Reducir»: tamaño del original y del resultado, en bytes. */
  inputBytes?: number;
  outputBytes?: number;
}

export interface JobFailure {
  source: string;
  code: ConversionErrorCode;
  message: string;
  detail?: string;
}

export interface JobResult {
  outputs: JobOutput[];
  failures: JobFailure[];
  skipped: { source: string; reason: string }[];
  cancelled: boolean;
}

export type ProgressCallback = (update: ProgressUpdate) => void;

function capsFromSpec(spec: JobSpec): EngineCaps {
  const ffmpeg: FfmpegCaps | null = spec.ffmpeg
    ? { path: spec.ffmpeg.path, version: spec.ffmpeg.version, encoders: new Set(spec.ffmpeg.encoders), source: 'bundled' }
    : null;
  // sharp y pdf.js se comprueban al cargarse: si faltan, el adaptador lanza «engine_unavailable».
  return { image: true, pdf: true, ffmpeg, office: spec.office?.apps ?? null };
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Lleva la cuenta de temporales para limpiarlos ante errores o cancelaciones. */
class TempTracker {
  private readonly paths = new Set<string>();
  private counter = 0;
  constructor(private readonly jobId: string) {}

  file(dir: string): string {
    const p = tempPathFor(dir, this.jobId, this.counter++);
    this.paths.add(p);
    return p;
  }

  async dir(parent: string): Promise<string> {
    const p = `${tempPathFor(parent, this.jobId, this.counter++)}-dir`;
    this.paths.add(p);
    await fs.mkdir(p);
    return p;
  }

  release(p: string): void {
    this.paths.delete(p);
  }

  async cleanup(): Promise<void> {
    await Promise.all([...this.paths].map((p) => removeQuietly(p)));
    this.paths.clear();
  }
}

async function writeTemp(tempPath: string, data: Uint8Array | string): Promise<void> {
  try {
    await fs.writeFile(tempPath, data, { flag: 'wx' });
  } catch (err) {
    throw toConversionError(err, 'write_failed');
  }
}

interface FileContext {
  spec: JobSpec;
  caps: EngineCaps;
  temps: TempTracker;
  signal: AbortSignal;
  report(fraction: number | null, step?: ProgressStep): void;
}

export async function runJob(spec: JobSpec, onProgress: ProgressCallback, signal: AbortSignal): Promise<JobResult> {
  const result: JobResult = { outputs: [], failures: [], skipped: [], cancelled: false };
  const caps = capsFromSpec(spec);
  const temps = new TempTracker(spec.id);
  const files = spec.target === 'pdf-merge' ? [...spec.files].sort((a, b) => naturalOrder.compare(path.basename(a.path), path.basename(b.path))) : spec.files;
  const total = spec.target === 'pdf-merge' ? 1 : files.length;
  let completed = 0;
  let currentIndex = 0;

  const report = (fraction: number | null, step?: ProgressStep): void => {
    let overall: number | null = null;
    if (fraction !== null) overall = (completed + fraction) / total;
    else if (total > 1) overall = completed / total;
    onProgress({ fileIndex: currentIndex, fileCount: total, completed, fraction, overall, step: step ?? null });
  };

  try {
    if (spec.target === 'pdf-merge') {
      try {
        const output = await mergeImagesToPdf(files, { spec, caps, temps, signal, report });
        result.outputs.push(output);
      } catch (err) {
        const e = toConversionError(err);
        if (e.code === 'cancelled') throw e;
        result.failures.push({ source: files[0]?.path ?? '', code: e.code, message: e.message, detail: e.detail });
      }
      completed = 1;
      report(null);
      return result;
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i] as JobFile;
      currentIndex = i;
      if (signal.aborted) throw new ConversionError('cancelled');
      report(null);

      if (file.format === spec.target) {
        result.skipped.push({ source: file.path, reason: `Ya está en ${FORMATS[file.format].label}` });
        completed++;
        continue;
      }
      try {
        const engine = engineFor(file.format, spec.target, caps);
        if (!engine) throw new ConversionError('unsupported', `${file.format} → ${spec.target}`);
        await validateSource(file.path, file.format);
        const output = await convertOne(file, spec.target as FormatId, engine, { spec, caps, temps, signal, report });
        result.outputs.push(output);
      } catch (err) {
        const e = toConversionError(err);
        if (e.code === 'cancelled' || signal.aborted) throw new ConversionError('cancelled');
        if (e.code === 'already_small' || e.code === 'single_page') {
          // No es un error: no hay nada útil que hacer (ya era ligero, o no hay páginas que separar).
          result.skipped.push({ source: file.path, reason: e.message });
          completed++;
          report(null);
          continue;
        }
        result.failures.push({ source: file.path, code: e.code, message: e.message, detail: e.detail });
      } finally {
        await temps.cleanup();
      }
      completed++;
      report(null);
    }
  } catch (err) {
    const e = toConversionError(err);
    if (e.code !== 'cancelled') throw e;
    result.cancelled = true;
  } finally {
    await temps.cleanup();
  }
  return result;
}

async function convertOne(file: JobFile, target: FormatId, engine: EngineKind, ctx: FileContext): Promise<JobOutput> {
  switch (engine) {
    case 'image':
      return convertImageFile(file, target, ctx);
    case 'image-pdf':
      return convertImageToPdf(file, ctx);
    case 'pdf-raster':
      return convertPdfToImages(file, target, ctx);
    case 'pdf-text':
      return convertPdfToText(file, ctx);
    case 'text-pdf':
      return convertTextToPdf(file, ctx);
    case 'text-docx':
      return convertTextToDocx(file, ctx);
    case 'image-shrink':
      return shrinkImageFile(file, ctx);
    case 'video-shrink':
      return shrinkVideoFile(file, ctx);
    case 'pdf-split':
      return splitPdfFile(file, ctx);
    case 'pdf-rotate':
      return rotatePdfFile(file, ctx);
    case 'pdf-shrink':
      return shrinkPdfFile(file, ctx);
    case 'ffmpeg-audio':
    case 'ffmpeg-video':
      return convertMedia(file, target, ctx);
    case 'office-pdf':
      return convertOfficeToPdf(file, ctx);
  }
}

function names(file: JobFile): { dir: string; base: string } {
  const dir = path.dirname(file.path);
  const { base } = splitFileName(path.basename(file.path));
  return { dir, base };
}

async function publishSingle(data: Uint8Array | string, file: JobFile, target: FormatId, ctx: FileContext, baseOverride?: string): Promise<JobOutput> {
  const { dir, base } = names(file);
  const temp = ctx.temps.file(dir);
  await writeTemp(temp, data);
  if (ctx.signal.aborted) throw new ConversionError('cancelled');
  const output = await publishFile(temp, dir, baseOverride ?? base, outputExtension(target)).catch((err: unknown) => {
    throw toConversionError(err, 'write_failed');
  });
  ctx.temps.release(temp);
  return { source: file.path, output, kind: 'file', count: 1 };
}

/** Escribe varias páginas en una carpeta temporal y la publica como «nombre (JPG)». */
async function publishPages(
  file: JobFile,
  target: FormatId,
  count: number,
  ctx: FileContext,
  producePage: (index: number) => Promise<Uint8Array>,
  folderLabel?: string,
): Promise<JobOutput> {
  const { dir, base } = names(file);
  const ext = outputExtension(target);
  const tempDir = await ctx.temps.dir(dir).catch((err: unknown) => {
    throw toConversionError(err, 'write_failed');
  });
  for (let i = 0; i < count; i++) {
    if (ctx.signal.aborted) throw new ConversionError('cancelled');
    const data = await producePage(i);
    await writeTemp(path.join(tempDir, pageFileName(base, i, count, ext)), data);
    ctx.report((i + 1) / count, { done: i + 1, total: count, unit: 'page' });
  }
  const written = await fs.readdir(tempDir);
  if (written.length !== count) throw new ConversionError('verify_failed', `Páginas escritas: ${written.length} de ${count}`);
  const output = await publishFolder(tempDir, dir, base, folderLabel ?? FORMATS[target].label).catch((err: unknown) => {
    throw toConversionError(err, 'write_failed');
  });
  ctx.temps.release(tempDir);
  return { source: file.path, output, kind: 'folder', count };
}

async function convertImageFile(file: JobFile, target: FormatId, ctx: FileContext): Promise<JobOutput> {
  const img = await openImage(file.path, file.format, ctx.spec.settings);
  if (img.multiPage) {
    // TIFF multipágina: cada página es un archivo independiente.
    return publishPages(file, target, img.pages, ctx, async (i) => (await encodeImage(img, target, ctx.spec.settings, i)).data);
  }
  const encoded = await encodeImage(img, target, ctx.spec.settings, 0);
  return publishSingle(encoded.data, file, target, ctx);
}

function pagesOf(img: OpenedImage): number[] {
  return img.multiPage ? Array.from({ length: img.pages }, (_, i) => i) : [0];
}

async function convertImageToPdf(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const img = await openImage(file.path, file.format, ctx.spec.settings);
  const { base } = names(file);
  const pdf = await createPdf(base);
  const pages = pagesOf(img);
  for (const [n, page] of pages.entries()) {
    if (ctx.signal.aborted) throw new ConversionError('cancelled');
    await addImagePage(pdf, img, page);
    if (pages.length > 1) ctx.report((n + 1) / pages.length, { done: n + 1, total: pages.length, unit: 'page' });
  }
  const data = await savePdf(pdf);
  await verifyPdf(data, pages.length);
  return publishSingle(data, file, 'pdf', ctx);
}

/** UNIR: imágenes y PDF (en cualquier combinación) en un único PDF, en orden natural de nombre. */
async function mergeImagesToPdf(files: JobFile[], ctx: FileContext): Promise<JobOutput> {
  const first = files[0];
  if (!first) throw new ConversionError('unsupported', 'Sin archivos');
  const { base } = names(first);
  const pdf = await createPdf(base);
  const unit = files.every((f) => f.format !== 'pdf') ? 'image' : 'file';
  let pageCount = 0;
  for (const [i, file] of files.entries()) {
    if (ctx.signal.aborted) throw new ConversionError('cancelled');
    await validateSource(file.path, file.format);
    try {
      if (file.format === 'pdf') {
        pageCount += await appendPdf(pdf, await loadEditablePdf(await readWhole(file.path)));
      } else {
        const img = await openImage(file.path, file.format, ctx.spec.settings);
        for (const page of pagesOf(img)) {
          await addImagePage(pdf, img, page);
          pageCount++;
        }
      }
    } catch (err) {
      // El aviso debe decir qué archivo falló, no solo el primero.
      const e = toConversionError(err);
      throw new ConversionError(e.code, `${path.basename(file.path)}: ${e.detail ?? e.message}`);
    }
    ctx.report((i + 1) / files.length, { done: i + 1, total: files.length, unit });
  }
  const data = await savePdf(pdf);
  await verifyPdf(data, pageCount);
  const output = await publishSingle(data, first, 'pdf', ctx, `${base}${text(ctx).output.merged}`);
  return { ...output, count: files.length };
}

async function encodeRenderedPage(rgba: Uint8ClampedArray, width: number, height: number, target: FormatId, settings: ConversionSettings): Promise<Buffer> {
  const sharp = await loadSharp();
  const raw = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const pipe = sharp(raw, { raw: { width, height, channels: 4 } }).removeAlpha().withMetadata({ density: settings.pdfDpi });
  let data: Buffer;
  let format: string;
  switch (target) {
    case 'jpg':
      data = await pipe.jpeg({ quality: settings.jpegQuality, chromaSubsampling: settings.jpegQuality >= 90 ? '4:4:4' : '4:2:0' }).toBuffer();
      format = 'jpeg';
      break;
    case 'png':
      data = await pipe.png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer();
      format = 'png';
      break;
    case 'webp':
      data = await pipe.webp({ quality: settings.webpQuality, effort: 4 }).toBuffer();
      format = 'webp';
      break;
    case 'tiff':
      data = await pipe.tiff({ compression: 'lzw', predictor: 'horizontal' }).toBuffer();
      format = 'tiff';
      break;
    default:
      throw new ConversionError('unsupported', `PDF → ${target}`);
  }
  await verifyEncoded(data, format);
  return data;
}

async function convertPdfToImages(file: JobFile, target: FormatId, ctx: FileContext): Promise<JobOutput> {
  const pdf = await openPdf(file.path);
  try {
    const count = pdf.numPages;
    if (count < 1) throw new ConversionError('corrupt', 'PDF sin páginas');
    const dpi = ctx.spec.settings.pdfDpi;
    const renderEncoded = async (i: number): Promise<{ data: Buffer; width: number; height: number }> => {
      const page = await renderPage(pdf, i + 1, dpi);
      const data = await encodeRenderedPage(page.data, page.width, page.height, target, ctx.spec.settings);
      return { data, width: page.width, height: page.height };
    };

    if (count === 1) {
      const page = await renderEncoded(0);
      ctx.report(1);
      return await publishSingle(page.data, file, target, ctx);
    }

    if (target === 'tiff') {
      // TIFF admite varias páginas en un solo archivo si todas tienen el mismo tamaño.
      const pages: Buffer[] = [];
      let uniform = true;
      let size: [number, number] | null = null;
      for (let i = 0; i < count; i++) {
        if (ctx.signal.aborted) throw new ConversionError('cancelled');
        const page = await renderEncoded(i);
        if (size && (size[0] !== page.width || size[1] !== page.height)) uniform = false;
        size ??= [page.width, page.height];
        pages.push(page.data);
        ctx.report((i + 1) / (count + 1), { done: i + 1, total: count, unit: 'page' });
      }
      if (uniform) {
        const sharp = await loadSharp();
        const joined = await sharp(pages, { join: { animated: true } }).tiff({ compression: 'lzw', predictor: 'horizontal' }).toBuffer();
        await verifyEncoded(joined, 'tiff');
        const meta = await sharp(joined).metadata();
        if ((meta.pages ?? 1) !== count) throw new ConversionError('verify_failed', `TIFF con ${meta.pages} páginas de ${count}`);
        ctx.report(1);
        const out = await publishSingle(joined, file, 'tiff', ctx);
        return { ...out, count };
      }
      return await publishPages(file, target, count, ctx, async (i) => pages[i] as Buffer);
    }

    return await publishPages(file, target, count, ctx, async (i) => (await renderEncoded(i)).data);
  } finally {
    await pdf.close();
  }
}

async function convertPdfToText(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const pdf = await openPdf(file.path);
  try {
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (ctx.signal.aborted) throw new ConversionError('cancelled');
      parts.push(await extractPageText(pdf, i));
      ctx.report(i / pdf.numPages, { done: i, total: pdf.numPages, unit: 'page' });
    }
    const text = parts.join('\n\n\f');
    if (text.replace(/[\s\f]/g, '').length === 0) throw new ConversionError('no_text');
    // UTF-8 con BOM: lo abren correctamente el Bloc de notas y las aplicaciones antiguas de Windows.
    const content = `﻿${text.replace(/\r?\n/g, '\r\n')}\r\n`;
    return await publishSingle(content, file, 'txt', ctx);
  } finally {
    await pdf.close();
  }
}

/** Textos en el idioma del trabajo. */
function text(ctx: FileContext): Messages {
  return messages(ctx.spec.language ?? 'es');
}

function replacedNote(n: number, ctx: FileContext): string | undefined {
  return n === 0 ? undefined : text(ctx).toast.replaced(n);
}

async function convertTextToPdf(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const fontPath = ctx.spec.fontPath;
  if (!fontPath) throw new ConversionError('engine_unavailable', 'Sin fuente para PDF');
  let fontBytes: Buffer;
  try {
    fontBytes = await fs.readFile(fontPath);
  } catch (err) {
    throw new ConversionError('engine_unavailable', `Fuente no disponible: ${(err as Error).message}`);
  }
  const { text } = await readText(file.path);
  const { base } = names(file);
  const pdf = await textToPdf(text, base, fontBytes, (done, total) => ctx.report(done / total, { done, total, unit: 'page' }), ctx.signal);
  await verifyPdf(pdf.data, pdf.pages);
  const output = await publishSingle(pdf.data, file, 'pdf', ctx);
  return { ...output, note: replacedNote(pdf.replaced, ctx) };
}

async function convertTextToDocx(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const { text } = await readText(file.path);
  const { base } = names(file);
  const docx = textToDocx(text, base);
  verifyDocx(docx.data, docx.paragraphs);
  ctx.report(1);
  const output = await publishSingle(docx.data, file, 'docx', ctx);
  return { ...output, note: replacedNote(docx.replaced, ctx) };
}

/**
 * Word, Excel o PowerPoint → PDF con Office. Office exporta a la carpeta temporal del sistema (rutas
 * cortas: Excel no admite más de 218 caracteres) y el PDF se publica como cualquier otro resultado.
 */
async function convertOfficeToPdf(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const office = ctx.spec.office;
  const app = officeAppFor(file.format);
  if (!office || !app || !office.apps[app]) throw new ConversionError('engine_unavailable', `Office no disponible para ${file.format}`);
  // Un DOCX/XLSX/PPTX con contraseña de apertura no es un ZIP sino un contenedor cifrado.
  if (isEncryptedOoxml(await readHeader(file.path, 8), file.format)) throw new ConversionError('doc_password', 'Documento cifrado (contenedor CFB)');

  const tempDir = await ctx.temps.dir(os.tmpdir()).catch((err: unknown) => {
    throw toConversionError(err, 'write_failed');
  });
  const exported = path.join(tempDir, 'documento.pdf');
  ctx.report(null);
  await exportWithOffice(office, app, file.path, exported, { signal: ctx.signal });
  if (ctx.signal.aborted) throw new ConversionError('cancelled');

  let data: Buffer;
  try {
    data = await readWhole(exported);
  } catch (err) {
    throw new ConversionError('office_failed', `Office no dejó el PDF: ${toConversionError(err).detail ?? ''}`);
  }
  // Se comprueba con dos lectores distintos que el PDF se abre y que su primera página se dibuja.
  const pages = (await loadEditablePdf(data)).getPageCount();
  if (pages < 1) throw new ConversionError('verify_failed', 'PDF sin páginas');
  const check = await openPdfData(data.slice());
  try {
    if (check.numPages !== pages) throw new ConversionError('verify_failed', `pdf.js: ${check.numPages} de ${pages} páginas`);
    await renderPage(check, 1, 36);
  } finally {
    await check.close();
  }
  ctx.report(1);
  return publishSingle(data, file, 'pdf', ctx);
}

async function splitPdfFile(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const source = await loadEditablePdf(await readWhole(file.path));
  const count = source.getPageCount();
  if (count < 2) throw new ConversionError('single_page');
  const { base } = names(file);
  const out = await publishPages(file, 'pdf', count, ctx, (i) => extractPage(source, i, text(ctx).output.pageTitle(base, i + 1)), text(ctx).output.pagesFolder);
  // Cada archivo debe abrirse y tener exactamente una página.
  for (const name of await fs.readdir(out.output)) await verifyPdf(await fs.readFile(path.join(out.output, name)), 1);
  return out;
}

async function rotatePdfFile(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const doc = await loadEditablePdf(await readWhole(file.path));
  const before = doc.getPages().map((p) => p.getRotation().angle);
  rotateAllPages(doc);
  const data = await savePdfBytes(doc);
  const check = await loadEditablePdf(data);
  const after = check.getPages().map((p) => p.getRotation().angle);
  if (after.length !== before.length || after.some((a, i) => a !== ((before[i] as number) + 90) % 360)) {
    throw new ConversionError('verify_failed', `Giros ${before.join(',')} → ${after.join(',')}`);
  }
  ctx.report(1);
  const { base } = names(file);
  return publishSingle(data, file, 'pdf', ctx, `${base}${text(ctx).output.rotated}`);
}

async function shrinkPdfFile(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const original = await readWhole(file.path);
  const doc = await loadEditablePdf(original);
  const pages = doc.getPageCount();
  const { shrinkMaxSide, shrinkQuality } = ctx.spec.settings;
  await shrinkPdfImages(doc, {
    maxSide: shrinkMaxSide,
    quality: shrinkQuality,
    signal: ctx.signal,
    onImage: (done, total) => ctx.report(done / (total + 1), { done, total, unit: 'image' }),
  });
  const data = await savePdfBytes(doc);
  assertSaves(original.length, data.length);
  await verifyPdf(data, pages);
  // Además se comprueba que pdf.js (otro lector) puede abrir el resultado y dibujar su primera página.
  const check = await openPdfData(data.slice());
  try {
    if (check.numPages !== pages) throw new ConversionError('verify_failed', `pdf.js: ${check.numPages} de ${pages} páginas`);
    await renderPage(check, 1, 36);
  } finally {
    await check.close();
  }
  ctx.report(1);
  const { base } = names(file);
  const output = await publishSingle(data, file, 'pdf', ctx, `${base}${text(ctx).output.shrunk}`);
  return { ...output, inputBytes: original.length, outputBytes: data.length };
}

/** Una reducción que no ahorra al menos un 5 % no merece un archivo nuevo. */
function assertSaves(before: number, after: number): void {
  if (after >= before * 0.95) throw new ConversionError('already_small', `${before} → ${after} bytes`);
}

async function shrinkImageFile(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const img = await openImage(file.path, file.format, ctx.spec.settings);
  const out = await shrinkImage(img, ctx.spec.settings);
  const before = img.buffer.length;
  assertSaves(before, out.data.length);
  ctx.report(1);
  const { base } = names(file);
  const output = await publishSingle(out.data, file, out.format, ctx, `${base}${text(ctx).output.shrunk}`);
  return { ...output, inputBytes: before, outputBytes: out.data.length };
}

async function shrinkVideoFile(file: JobFile, ctx: FileContext): Promise<JobOutput> {
  const caps = ctx.caps.ffmpeg;
  if (!caps) throw new ConversionError('engine_unavailable', 'FFmpeg no disponible');
  const before = (await fs.stat(file.path)).size;
  const info = await probeMedia(caps.path, file.path, ctx.signal);
  const { dir, base } = names(file);
  const temp = ctx.temps.file(dir);
  const { shrinkVideoMaxSide, shrinkVideoCrf } = ctx.spec.settings;
  const plan = planShrink(info, caps, file.path, temp, shrinkVideoMaxSide, shrinkVideoCrf);
  await runFfmpeg(caps.path, plan.args, { duration: info.duration, signal: ctx.signal, onProgress: (f) => ctx.report(info.duration ? f : null) });
  const after = (await fs.stat(temp)).size;
  if (after === 0) throw new ConversionError('verify_failed', 'Salida vacía');
  const check = await probeMedia(caps.path, temp, ctx.signal);
  if (!check.video || (info.audio && !check.audio)) throw new ConversionError('verify_failed', 'Faltan pistas en el vídeo reducido');
  const longest = Math.max(check.video.width ?? 0, check.video.height ?? 0);
  if (longest > shrinkVideoMaxSide) throw new ConversionError('verify_failed', `Lado mayor ${longest} > ${shrinkVideoMaxSide}`);
  assertSaves(before, after);
  const output = await publishFile(temp, dir, `${base}${text(ctx).output.shrunk}`, 'mp4').catch((err: unknown) => {
    throw toConversionError(err, 'write_failed');
  });
  ctx.temps.release(temp);
  return { source: file.path, output, kind: 'file', count: 1, inputBytes: before, outputBytes: after };
}

async function convertMedia(file: JobFile, target: FormatId, ctx: FileContext): Promise<JobOutput> {
  const caps = ctx.caps.ffmpeg;
  if (!caps) throw new ConversionError('engine_unavailable', 'FFmpeg no disponible');
  const info = await probeMedia(caps.path, file.path, ctx.signal);
  const { dir, base } = names(file);
  let lastError: ConversionError | null = null;

  const temp = ctx.temps.file(dir);
  const plans = planConversion(info, target, caps, file.path, temp);
  for (const plan of plans) {
    if (ctx.signal.aborted) throw new ConversionError('cancelled');
    await removeQuietly(temp);
    try {
      await runFfmpeg(caps.path, plan.args, { duration: info.duration, signal: ctx.signal, onProgress: (f) => ctx.report(info.duration ? f : null) });
      const stat = await fs.stat(temp);
      if (stat.size === 0) throw new ConversionError('verify_failed', 'Salida vacía');
      const check = await probeMedia(caps.path, temp, ctx.signal);
      const expectsVideo = FORMATS[target].category === 'video' || target === 'gif';
      if (expectsVideo ? !check.video : !check.audio) throw new ConversionError('verify_failed', 'La salida no contiene la pista esperada');
      lastError = null;
      break;
    } catch (err) {
      lastError = toConversionError(err);
      if (lastError.code === 'cancelled' || lastError.code === 'no_audio') throw lastError;
    }
  }
  if (lastError) throw lastError;
  const output = await publishFile(temp, dir, base, outputExtension(target)).catch((err: unknown) => {
    throw toConversionError(err, 'write_failed');
  });
  ctx.temps.release(temp);
  return { source: file.path, output, kind: 'file', count: 1 };
}
