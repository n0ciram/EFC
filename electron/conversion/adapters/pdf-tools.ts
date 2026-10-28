/**
 * Herramientas de PDF con pdf-lib, todo en local: unir, separar páginas, girar y reducir el tamaño.
 *
 * - Unir y separar copian las páginas tal cual (texto seleccionable, vectores, fuentes): no se
 *   rasteriza nada.
 * - Reducir recomprime las imágenes internas (lo que hace pesar a un PDF escaneado o con fotos):
 *   limita su lado mayor y las guarda en JPEG. El texto y los vectores no se tocan. Solo se sustituye
 *   una imagen si la nueva pesa claramente menos, y las que no se pueden tratar con seguridad (con
 *   máscara de transparencia, colores indexados, 1 bit, etc.) se dejan como están.
 * - Los PDF cifrados no se pueden modificar sin descifrarlos, y pdf-lib no lo hace: se informa de ello.
 */
import {
  degrees,
  decodePDFRawStream,
  EncryptedPDFError,
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from 'pdf-lib';
import { ConversionError } from '../errors';
import { loadSharp } from './image';

/** Abre un PDF para modificarlo. Los cifrados (aunque solo tengan restricciones) no se pueden editar. */
export async function loadEditablePdf(data: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(data, { updateMetadata: false });
  } catch (err) {
    // pdf-lib está compilado a ES5 y sus errores pierden la clase: se reconoce también por el mensaje
    // o por el diccionario /Encrypt del propio archivo.
    const message = (err as Error)?.message ?? String(err);
    const encrypted = err instanceof EncryptedPDFError || /is encrypted/i.test(message) || Buffer.from(data).includes('/Encrypt');
    if (encrypted) throw new ConversionError('protected', message);
    throw new ConversionError('corrupt', message);
  }
}

export async function savePdfBytes(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true });
}

/** Añade todas las páginas de `source` al final de `target`. Devuelve cuántas se añadieron. */
export async function appendPdf(target: PDFDocument, source: PDFDocument): Promise<number> {
  const pages = await target.copyPages(source, source.getPageIndices());
  for (const page of pages) target.addPage(page);
  return pages.length;
}

/** Documento nuevo con una sola página de `source`. */
export async function extractPage(source: PDFDocument, index: number, title: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('EFC — Easy File Converter');
  const [page] = await doc.copyPages(source, [index]);
  doc.addPage(page as NonNullable<typeof page>);
  return savePdfBytes(doc);
}

/** Gira todas las páginas 90° en el sentido de las agujas del reloj (se suma a su giro actual). */
export function rotateAllPages(doc: PDFDocument): void {
  for (const page of doc.getPages()) {
    page.setRotation(degrees((((page.getRotation().angle + 90) % 360) + 360) % 360));
  }
}

// ---------------------------------------------------------------------------------------------
// Reducir: recompresión de imágenes internas

export interface PdfShrinkOptions {
  maxSide: number;
  quality: number;
  signal?: AbortSignal;
  onImage?(done: number, total: number): void;
}

export interface PdfShrinkReport {
  images: number;
  recompressed: number;
}

const N = (name: string): PDFName => PDFName.of(name);

function lookup(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? doc.context.lookup(value) : value;
}

function numberOf(doc: PDFDocument, dict: PDFDict, key: string): number | null {
  const v = lookup(doc, dict.get(N(key)));
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** Filtro único de la imagen (o `null` si hay varios encadenados). */
function singleFilter(doc: PDFDocument, dict: PDFDict): string | null | undefined {
  const f = lookup(doc, dict.get(N('Filter')));
  if (f === undefined) return undefined;
  if (f instanceof PDFName) return f.decodeText();
  if (f instanceof PDFArray && f.size() === 1) {
    const only = lookup(doc, f.get(0));
    return only instanceof PDFName ? only.decodeText() : null;
  }
  return null;
}

/** Número de componentes de color (1 gris, 3 RGB, 4 CMYK) o `null` si el espacio no es seguro de tratar. */
function components(doc: PDFDocument, dict: PDFDict): number | null {
  const cs = lookup(doc, dict.get(N('ColorSpace')));
  if (cs instanceof PDFName) {
    return ({ DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 } as Record<string, number>)[cs.decodeText()] ?? null;
  }
  if (cs instanceof PDFArray && cs.size() === 2) {
    const kind = lookup(doc, cs.get(0));
    const profile = lookup(doc, cs.get(1));
    if (kind instanceof PDFName && kind.decodeText() === 'ICCBased' && profile instanceof PDFRawStream) {
      const n = numberOf(doc, profile.dict, 'N');
      return n === 1 || n === 3 || n === 4 ? n : null;
    }
  }
  return null;
}

async function recompress(doc: PDFDocument, stream: PDFRawStream, opts: PdfShrinkOptions): Promise<PDFRawStream | null> {
  const dict = stream.dict;
  if (lookup(doc, dict.get(N('ImageMask'))) === PDFBool.True) return null;
  if (dict.has(N('SMask')) || dict.has(N('Mask')) || dict.has(N('Decode'))) return null;
  const width = numberOf(doc, dict, 'Width');
  const height = numberOf(doc, dict, 'Height');
  const channels = components(doc, dict);
  if (!width || !height || !channels) return null;
  // Imágenes pequeñas (iconos, logotipos): no merece la pena y se podría perder nitidez.
  if (Math.max(width, height) <= 512 && stream.contents.length < 64 * 1024) return null;

  const sharp = await loadSharp();
  const filter = singleFilter(doc, dict);
  let input;
  if (filter === 'DCTDecode') {
    input = sharp(Buffer.from(stream.contents), { failOn: 'error' });
  } else if (filter === 'FlateDecode' || filter === undefined) {
    if (numberOf(doc, dict, 'BitsPerComponent') !== 8 || channels === 4) return null;
    const params = lookup(doc, dict.get(N('DecodeParms')));
    if (params instanceof PDFDict && (numberOf(doc, params, 'Predictor') ?? 1) > 1) return null;
    const raw = decodePDFRawStream(stream).decode();
    if (raw.length !== width * height * channels) return null;
    input = sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), { raw: { width, height, channels: channels as 1 | 3 } });
  } else {
    return null; // JBIG2, CCITT, JPX…: suelen estar ya muy comprimidos.
  }

  const gray = channels === 1;
  const { data, info } = await input
    .resize({ width: opts.maxSide, height: opts.maxSide, fit: 'inside', withoutEnlargement: true })
    .toColourspace(gray ? 'b-w' : 'srgb')
    .jpeg({ quality: opts.quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  if (data.length >= stream.contents.length * 0.9) return null;

  return doc.context.stream(data, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: info.width,
    Height: info.height,
    ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  });
}

export async function shrinkPdfImages(doc: PDFDocument, opts: PdfShrinkOptions): Promise<PdfShrinkReport> {
  const all: [PDFRef, PDFRawStream][] = [];
  const masks = new Set<string>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || lookup(doc, obj.dict.get(N('Subtype'))) !== N('Image')) continue;
    all.push([ref, obj]);
    // Las máscaras de transparencia van ligadas a su imagen: no se tocan por separado.
    for (const key of ['SMask', 'Mask']) {
      const m = obj.dict.get(N(key));
      if (m instanceof PDFRef) masks.add(m.toString());
    }
  }
  const images = all.filter(([ref]) => !masks.has(ref.toString()));
  let recompressed = 0;
  for (const [i, [ref, stream]] of images.entries()) {
    if (opts.signal?.aborted) throw new ConversionError('cancelled');
    // Una imagen que no se puede tratar se deja intacta: nunca se estropea el documento por intentarlo.
    const replacement = await recompress(doc, stream, opts).catch(() => null);
    if (replacement) {
      doc.context.assign(ref, replacement);
      recompressed++;
    }
    opts.onImage?.(i + 1, images.length);
  }
  return { images: images.length, recompressed };
}
