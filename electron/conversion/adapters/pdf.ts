/**
 * Lectura de PDF con pdf.js (Mozilla) y lienzo @napi-rs/canvas: páginas a imagen y extracción de texto.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unpackedPath } from '../asar';
import { ConversionError, toConversionError } from '../errors';
import { readWhole } from '../io';

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
type LoadingTask = ReturnType<PdfjsModule['getDocument']>;

interface CanvasAndContext {
  canvas: unknown;
  context: { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } };
}
interface CanvasFactoryLike {
  create(width: number, height: number): CanvasAndContext;
  destroy(canvasAndContext: CanvasAndContext): void;
}

const localRequire = createRequire(__filename);

/** pdf.js lee estos recursos con `fs.readFile(base + nombre)` y exige que la base termine en «/». */
function assetDir(dir: string): string {
  return dir.split(path.sep).join('/') + '/';
}

interface PdfjsBundle {
  pdfjs: PdfjsModule;
  assets: { standardFontDataUrl: string; cMapUrl: string; wasmUrl: string; iccUrl: string };
}

let pdfjsPromise: Promise<PdfjsBundle> | null = null;

/**
 * pdf.js decide al cargarse si está en Node.js y descarta los procesos de Electron cuyo `process.type`
 * no es «browser». El proceso de utilidad de conversión (`process.type === 'utility'`) es Node.js a
 * todos los efectos, así que durante la carga se presenta como tal; después se restaura el valor.
 * Sin esto, pdf.js intentaría usar el DOM (inexistente aquí) y fallaría con «DOMMatrix is not defined».
 */
async function asNodeEnvironment<T>(load: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'type');
  const type = (process as { type?: string }).type;
  if (!process.versions.electron || !type || type === 'browser' || !descriptor?.configurable) return load();
  Object.defineProperty(process, 'type', { ...descriptor, value: 'browser' });
  try {
    return await load();
  } finally {
    Object.defineProperty(process, 'type', descriptor);
  }
}

export async function loadPdfjs(): Promise<PdfjsBundle> {
  pdfjsPromise ??= (async () => {
    const entry = unpackedPath(localRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs'));
    const workerEntry = unpackedPath(localRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'));
    const pkgDir = path.resolve(path.dirname(entry), '..', '..');
    const pdfjs = await asNodeEnvironment(async () => {
      const mod = (await import(pathToFileURL(entry).href)) as PdfjsModule;
      // El «worker» de pdf.js se ejecuta en este mismo proceso; se carga ya para que también se
      // inicialice en modo Node (pdf.js lo reutiliza a través de globalThis.pdfjsWorker).
      const worker = (await import(pathToFileURL(workerEntry).href)) as { WorkerMessageHandler?: unknown };
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      return mod;
    });
    return {
      pdfjs,
      assets: {
        standardFontDataUrl: assetDir(path.join(pkgDir, 'standard_fonts')),
        cMapUrl: assetDir(path.join(pkgDir, 'cmaps')),
        wasmUrl: assetDir(path.join(pkgDir, 'wasm')),
        iccUrl: assetDir(path.join(pkgDir, 'iccs')),
      },
    };
  })();
  try {
    return await pdfjsPromise;
  } catch (err) {
    pdfjsPromise = null;
    throw new ConversionError('engine_unavailable', `pdf.js: ${(err as Error).message}`);
  }
}

export interface OpenedPdf {
  doc: PdfDocument;
  numPages: number;
  close(): Promise<void>;
}

export async function openPdf(filePath: string): Promise<OpenedPdf> {
  return openPdfData(await readWhole(filePath));
}

/** Abre un PDF ya en memoria (p. ej. un resultado recién generado, para verificarlo). */
export async function openPdfData(bytes: Uint8Array): Promise<OpenedPdf> {
  const { pdfjs, assets } = await loadPdfjs();
  let task: LoadingTask | null = null;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      ...assets,
      cMapPacked: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    const loaded = task;
    return {
      doc,
      numPages: doc.numPages,
      close: async () => {
        await loaded.destroy().catch(() => undefined);
      },
    };
  } catch (err) {
    await task?.destroy().catch(() => undefined);
    const name = (err as Error | undefined)?.name ?? '';
    if (name === 'PasswordException') throw new ConversionError('password');
    if (name === 'InvalidPDFException' || name === 'FormatError' || name === 'UnknownErrorException') {
      throw new ConversionError('corrupt', (err as Error).message);
    }
    throw toConversionError(err, 'corrupt');
  }
}

export interface RenderedPage {
  /** Píxeles RGBA de 8 bits. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Límites para no agotar la memoria con páginas gigantes (planos A0, pósteres…). */
const MAX_PAGE_PIXELS = 60_000_000;
const MAX_PAGE_SIDE = 16_000;

/** Rasteriza una página (numerada desde 1) sobre fondo blanco a la resolución indicada. */
export async function renderPage(pdf: OpenedPdf, pageNumber: number, dpi: number): Promise<RenderedPage> {
  const page = await pdf.doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const area = Math.max(1, base.width * base.height);
    const scale = Math.min(dpi / 72, Math.sqrt(MAX_PAGE_PIXELS / area), MAX_PAGE_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    const factory = pdf.doc.canvasFactory as unknown as CanvasFactoryLike;
    const target = factory.create(width, height);
    try {
      await page.render({
        canvas: target.canvas as never,
        viewport,
        background: 'rgb(255,255,255)',
      }).promise;
      const { data } = target.context.getImageData(0, 0, width, height);
      return { data, width, height };
    } finally {
      factory.destroy(target);
    }
  } catch (err) {
    throw toConversionError(err, 'corrupt');
  } finally {
    page.cleanup();
  }
}

/** Extrae el texto de una página respetando los saltos de línea que indica el PDF. */
export async function extractPageText(pdf: OpenedPdf, pageNumber: number): Promise<string> {
  const page = await pdf.doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if ('str' in item) {
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
    }
    return text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  } catch (err) {
    throw toConversionError(err, 'corrupt');
  } finally {
    page.cleanup();
  }
}
