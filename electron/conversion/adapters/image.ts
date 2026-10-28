/**
 * Adaptador de imágenes basado en sharp (libvips), más el códec BMP y el escritor ICO propios.
 */
import { createRequire } from 'node:module';
import type { Metadata, Sharp, SharpOptions } from 'sharp';
import type { FormatId } from '../../../src/types/formats';
import { ConversionError, toConversionError } from '../errors';
import { FORMATS } from '../formats';
import { readWhole } from '../io';
import type { ConversionSettings } from '../settings';
import { decodeBmp, encodeBmp, readBmpHeader } from './bmp-codec';
import { encodeIco, ICO_SIZES, readIcoDirectory } from './ico-codec';

type SharpModule = typeof import('sharp').default;

const localRequire = createRequire(__filename);

/**
 * Motor de sharp en uso: los binarios nativos de la plataforma o, si no están, la compilación en
 * WebAssembly (más lenta y limitada a 4 GB de memoria, pero idéntica en formatos y resultados).
 */
export function sharpBackend(): 'nativo' | 'WebAssembly' {
  try {
    localRequire.resolve(`@img/sharp-${process.platform}-${process.arch}/sharp.node`);
    return 'nativo';
  } catch {
    return 'WebAssembly';
  }
}

/**
 * Límite de píxeles de entrada: el mismo que sharp por defecto (≈ 16384 × 16384) con los binarios
 * nativos; con WebAssembly, 100 megapíxeles para no agotar su memoria (el error se explica al usuario).
 */
export const MAX_INPUT_PIXELS = sharpBackend() === 'nativo' ? 268_402_689 : 100_000_000;

let sharpPromise: Promise<SharpModule> | null = null;

/** Carga sharp bajo demanda; si sus binarios faltan, la conversión informa de que el motor no está disponible. */
export async function loadSharp(): Promise<SharpModule> {
  sharpPromise ??= import('sharp').then((mod) => {
    const candidate = (mod as unknown as { default?: SharpModule }).default ?? (mod as unknown as SharpModule);
    return candidate;
  });
  try {
    return await sharpPromise;
  } catch (err) {
    sharpPromise = null;
    throw new ConversionError('engine_unavailable', `sharp: ${(err as Error).message}`);
  }
}

export interface OpenedImage {
  format: FormatId;
  /** Dimensiones de la primera página ya orientada según EXIF. */
  width: number;
  height: number;
  pages: number;
  /** GIF/WebP con varios fotogramas. */
  animated: boolean;
  /** TIFF con varias páginas (documentos escaneados, faxes…). */
  multiPage: boolean;
  hasAlpha: boolean;
  density: number | null;
  depth16: boolean;
  space: string;
  channels: number;
  orientation: number;
  /** Solo SVG: lado mayor a 72 ppp, para rasterizar a un tamaño exacto. */
  svgIntrinsicLongest: number | null;
  /** Bytes originales (útil para incrustar JPEG/PNG en un PDF sin recomprimir). */
  buffer: Buffer;
  /** Crea una canalización nueva de sharp (cada instancia solo se puede usar una vez). */
  pipeline(options?: { page?: number; animated?: boolean; svgDensity?: number }): Sharp;
}

export async function openImage(filePath: string, format: FormatId, settings: ConversionSettings): Promise<OpenedImage> {
  const sharp = await loadSharp();
  const buffer = await readWhole(filePath);

  if (format === 'bmp') {
    let decoded;
    try {
      decoded = decodeBmp(buffer);
    } catch (err) {
      throw new ConversionError('corrupt', (err as Error).message);
    }
    const raw = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    const { width, height } = decoded;
    return {
      format,
      width,
      height,
      pages: 1,
      animated: false,
      multiPage: false,
      hasAlpha: decoded.hasAlpha,
      density: decoded.dpi,
      depth16: false,
      space: 'srgb',
      channels: 4,
      orientation: 1,
      svgIntrinsicLongest: null,
      buffer,
      pipeline: () => sharp(raw, { raw: { width, height, channels: 4 }, limitInputPixels: MAX_INPUT_PIXELS }),
    };
  }

  const baseOptions: SharpOptions = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };
  let meta: Metadata;
  try {
    meta = await sharp(buffer, baseOptions).metadata();
  } catch (err) {
    throw toConversionError(err, 'corrupt');
  }
  if (!meta.width || !meta.height) throw new ConversionError('corrupt', 'Sin dimensiones');

  const pages = meta.pages && meta.pages > 1 ? meta.pages : 1;
  const animated = (format === 'gif' || format === 'webp') && pages > 1;
  const multiPage = format === 'tiff' && pages > 1;
  const orientation = meta.orientation ?? 1;
  const oriented = meta.autoOrient ?? { width: meta.width, height: meta.height };
  const pageHeight = animated && meta.pageHeight ? meta.pageHeight : oriented.height;

  let svgDensity: number | undefined;
  let width = oriented.width;
  let height = pageHeight;
  if (format === 'svg') {
    const longest = Math.max(width, height);
    const scale = longest < settings.svgMinSize ? Math.min(32, settings.svgMinSize / longest) : 1;
    svgDensity = 72 * scale;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  return {
    format,
    width,
    height,
    pages,
    animated,
    multiPage,
    hasAlpha: meta.hasAlpha,
    density: meta.density && meta.density >= 30 && meta.density <= 4800 && format !== 'svg' ? meta.density : null,
    depth16: meta.depth === 'ushort',
    space: meta.space,
    channels: meta.channels,
    orientation,
    svgIntrinsicLongest: format === 'svg' ? Math.max(oriented.width, oriented.height) : null,
    buffer,
    pipeline: (options = {}) => {
      const opts: SharpOptions = { ...baseOptions };
      if (options.animated) opts.animated = true;
      else if (options.page !== undefined) opts.page = options.page;
      if (format === 'svg') opts.density = options.svgDensity ?? svgDensity ?? 72;
      const pipe = sharp(buffer, opts);
      return options.animated ? pipe : pipe.autoOrient();
    },
  };
}

/** Prepara la canalización para salida en color de 8 o 16 bits según el origen. */
function colourFor(pipe: Sharp, img: OpenedImage, allow16: boolean): Sharp {
  if (img.space === 'cmyk') return pipe.toColourspace('srgb');
  if (allow16 && img.depth16) {
    return pipe.toColourspace(img.channels <= 2 ? 'grey16' : 'rgb16');
  }
  return pipe;
}

export interface EncodedImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Codifica una página (o la animación completa, si procede) en el formato de destino.
 * `page` se ignora para orígenes animados cuando el destino también admite animación.
 */
export async function encodeImage(
  img: OpenedImage,
  target: FormatId,
  settings: ConversionSettings,
  page = 0,
): Promise<EncodedImage> {
  const keepAnimation = img.animated && (target === 'gif' || target === 'webp');
  const source = keepAnimation ? img.pipeline({ animated: true }) : img.pipeline({ page });
  const keepMeta = (p: Sharp): Sharp => (img.space === 'cmyk' ? p.keepExif() : p.keepExif().keepIccProfile());

  try {
    switch (target) {
      case 'jpg': {
        const q = settings.jpegQuality;
        const pipe = keepMeta(colourFor(source, img, false))
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: q, chromaSubsampling: q >= 90 ? '4:4:4' : '4:2:0', mozjpeg: false });
        return await finish(pipe, 'jpeg');
      }
      case 'png': {
        const pipe = keepMeta(colourFor(source, img, true)).png({ compressionLevel: 6, adaptiveFiltering: true });
        return await finish(pipe, 'png');
      }
      case 'webp': {
        const lossless = !FORMATS[img.format].lossy;
        const pipe = keepMeta(colourFor(source, img, false)).webp(
          lossless ? { lossless: true, effort: 4 } : { quality: settings.webpQuality, alphaQuality: 100, effort: 4, smartSubsample: true },
        );
        return await finish(pipe, 'webp');
      }
      case 'avif': {
        const pipe = keepMeta(colourFor(source, img, false)).avif({ quality: settings.avifQuality, effort: 4 });
        return await finish(pipe, 'heif');
      }
      case 'tiff': {
        const pipe = keepMeta(colourFor(source, img, true)).tiff({ compression: 'lzw', predictor: 'horizontal' });
        return await finish(pipe, 'tiff');
      }
      case 'gif': {
        const pipe = colourFor(source, img, false).gif({ effort: 7, dither: 1, reuse: true });
        return await finish(pipe, 'gif');
      }
      case 'bmp': {
        const { data, info } = await source
          .toColourspace('srgb')
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (info.channels !== 4) throw new ConversionError('unknown', `Canales inesperados: ${info.channels}`);
        const encoded = Buffer.from(encodeBmp({ width: info.width, height: info.height, data, dpi: img.density }));
        const header = readBmpHeader(encoded);
        if (header.width !== info.width || header.height !== info.height) throw new ConversionError('verify_failed');
        return { data: encoded, width: info.width, height: info.height };
      }
      case 'ico':
        return await encodeIcon(img, page);
      default:
        throw new ConversionError('unsupported', `Destino de imagen no soportado: ${target}`);
    }
  } catch (err) {
    throw toConversionError(err, 'corrupt');
  }
}

async function finish(pipe: Sharp, expectedFormat: string): Promise<EncodedImage> {
  const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
  await verifyEncoded(data, expectedFormat);
  return { data, width: info.width, height: info.pageHeight ?? info.height };
}

/** Comprueba que el resultado se puede volver a leer y tiene el formato esperado. */
export async function verifyEncoded(data: Buffer, expectedFormat: string): Promise<void> {
  if (data.length === 0) throw new ConversionError('verify_failed', 'Salida vacía');
  const sharp = await loadSharp();
  try {
    const meta = await sharp(data, { limitInputPixels: false }).metadata();
    if (meta.format !== expectedFormat || !meta.width || !meta.height) {
      throw new ConversionError('verify_failed', `Formato ${meta.format}, esperado ${expectedFormat}`);
    }
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError('verify_failed', (err as Error).message);
  }
}

async function encodeIcon(img: OpenedImage, page: number): Promise<EncodedImage> {
  const entries = [];
  for (const size of ICO_SIZES) {
    // Los SVG se rasterizan directamente al tamaño de cada entrada para que queden nítidos.
    const svgDensity = img.svgIntrinsicLongest ? Math.min(100_000, Math.max(1, (72 * size) / img.svgIntrinsicLongest)) : undefined;
    const png = await img
      .pipeline({ page, svgDensity })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
      .toColourspace('srgb')
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer();
    entries.push({ size, png });
  }
  const data = Buffer.from(encodeIco(entries));
  const dir = readIcoDirectory(data);
  if (dir.length !== ICO_SIZES.length || dir.some((e) => !e.isPng)) throw new ConversionError('verify_failed', 'ICO incompleto');
  return { data, width: 256, height: 256 };
}

/**
 * Formato de una imagen reducida: el mismo que el original, salvo BMP y TIFF de una página, que se
 * guardan en JPG (o PNG si tienen transparencia) porque pesan mucho y el correo apenas los muestra.
 */
export function shrinkFormat(img: OpenedImage): FormatId {
  if (img.format === 'bmp' || (img.format === 'tiff' && !img.multiPage)) return img.hasAlpha ? 'png' : 'jpg';
  return img.format;
}

const SHRINK_EXPECTED: Partial<Record<FormatId, string>> = { jpg: 'jpeg', png: 'png', webp: 'webp', avif: 'heif', gif: 'gif', tiff: 'tiff' };

/**
 * «Reducir»: limita el lado mayor (sin ampliar nunca) y recomprime para enviar por correo o mensajería.
 * Se aplica la orientación EXIF, se pasa a sRGB y se eliminan los metadatos (incluida la ubicación GPS).
 * Las animaciones GIF y WebP se conservan, y un TIFF de varias páginas sigue teniéndolas.
 */
export async function shrinkImage(img: OpenedImage, settings: ConversionSettings): Promise<EncodedImage & { format: FormatId }> {
  const max = settings.shrinkMaxSide;
  const q = settings.shrinkQuality;
  const format = shrinkFormat(img);
  const fit = (p: Sharp): Sharp =>
    p.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' }).toColourspace('srgb');

  try {
    if (img.multiPage) {
      // TIFF de varias páginas: cada página reducida en JPEG dentro de un TIFF multipágina.
      const sharp = await loadSharp();
      const pages: Buffer[] = [];
      let size: string | null = null;
      for (let page = 0; page < img.pages; page++) {
        const { data, info } = await fit(img.pipeline({ page }))
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: q })
          .toBuffer({ resolveWithObject: true });
        const key = `${info.width}x${info.height}`;
        if (size && size !== key) throw new ConversionError('unsupported', 'TIFF con páginas de distinto tamaño');
        size = key;
        pages.push(data);
      }
      const pipe = sharp(pages, { join: { animated: true } }).tiff({ compression: 'jpeg', quality: q });
      const out = await finish(pipe, 'tiff');
      const meta = await sharp(out.data).metadata();
      if ((meta.pages ?? 1) !== img.pages) throw new ConversionError('verify_failed', `TIFF con ${meta.pages} páginas de ${img.pages}`);
      return { ...out, format };
    }

    const keepAnimation = img.animated && (format === 'gif' || format === 'webp');
    const source = (): Sharp => fit(keepAnimation ? img.pipeline({ animated: true }) : img.pipeline({ page: 0 }));
    if (format === 'png') {
      // La paleta (256 colores con difuminado) es ideal para capturas y gráficos; en degradados y fotos
      // puede pesar más que el color completo. Se prueban las dos y se queda la más ligera.
      const palette = await finish(source().png({ palette: true, quality: q, effort: 8, compressionLevel: 9, dither: 1 }), 'png');
      const full = await finish(source().png({ compressionLevel: 9, adaptiveFiltering: true }), 'png');
      return { ...(palette.data.length <= full.data.length ? palette : full), format };
    }
    let pipe = source();
    switch (format) {
      case 'jpg':
        pipe = pipe.flatten({ background: '#ffffff' }).jpeg({ quality: q, mozjpeg: true });
        break;
      case 'webp':
        pipe = pipe.webp({ quality: q, alphaQuality: 90, effort: 5, smartSubsample: true });
        break;
      case 'avif':
        pipe = pipe.avif({ quality: Math.max(20, q - 25), effort: 5 });
        break;
      case 'gif':
        pipe = pipe.gif({ effort: 7, colours: 128, dither: 1 });
        break;
      default:
        throw new ConversionError('unsupported', `Reducir ${img.format}`);
    }
    return { ...(await finish(pipe, SHRINK_EXPECTED[format] as string)), format };
  } catch (err) {
    throw toConversionError(err, 'corrupt');
  }
}

/** Número de páginas que produce un origen al convertirse a un formato estático. */
export function staticPageCount(img: OpenedImage): number {
  return img.multiPage ? img.pages : 1;
}
