/**
 * Códec BMP propio (lectura y escritura).
 *
 * El motor de imágenes (sharp/libvips) no incluye BMP en sus binarios precompilados, así que
 * EFC lo implementa aquí. Lectura: cabeceras CORE/INFO/V2–V5, 1/2/4/8/16/24/32 bits, paletas,
 * BI_BITFIELDS/BI_ALPHABITFIELDS, RLE8/RLE4 y filas de arriba abajo. Escritura: 24 bits
 * (máxima compatibilidad) o 32 bits con canal alfa (cabecera V4) cuando hay transparencia.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** Píxeles RGBA de 8 bits, fila a fila de arriba abajo. */
  data: Uint8Array;
  /** La imagen tiene algún píxel no opaco. */
  hasAlpha: boolean;
  /** Resolución en puntos por pulgada, si el archivo la declara. */
  dpi: number | null;
}

export class BmpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BmpError';
  }
}

/** Límite de píxeles para proteger la memoria ante cabeceras malformadas. */
const MAX_PIXELS = 268_402_689; // el mismo límite por defecto que sharp

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_JPEG = 4;
const BI_PNG = 5;
const BI_ALPHABITFIELDS = 6;

interface Mask {
  mask: number;
  shift: number;
  bits: number;
}

function makeMask(mask: number): Mask {
  mask >>>= 0;
  if (mask === 0) return { mask: 0, shift: 0, bits: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let bits = 0;
  while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1) === 1) bits++;
  return { mask, shift, bits };
}

function readMasked(value: number, m: Mask): number {
  if (m.bits === 0) return 0;
  const v = ((value & m.mask) >>> 0) >>> m.shift;
  if (m.bits >= 8) return v >>> (m.bits - 8);
  const max = (1 << m.bits) - 1;
  return Math.round((v * 255) / max);
}

/** Decodifica un BMP a RGBA. Lanza `BmpError` si el archivo no es válido o no está soportado. */
export function decodeBmp(input: Uint8Array): RgbaImage {
  if (input.length < 26 || input[0] !== 0x42 || input[1] !== 0x4d) {
    throw new BmpError('No es un archivo BMP válido.');
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const dibSize = view.getUint32(14, true);

  let width: number;
  let height: number;
  let bpp: number;
  let compression = BI_RGB;
  let colorsUsed = 0;
  let xppm = 0;
  let paletteEntrySize = 4;
  let masks: [Mask, Mask, Mask, Mask] | null = null;
  let afterHeader = 14 + dibSize;

  if (dibSize === 12) {
    width = view.getUint16(18, true);
    height = view.getInt16(20, true);
    bpp = view.getUint16(24, true);
    paletteEntrySize = 3;
  } else if (dibSize >= 16 && input.length >= 14 + Math.min(dibSize, 40)) {
    width = view.getInt32(18, true);
    height = view.getInt32(22, true);
    bpp = view.getUint16(28, true);
    if (dibSize >= 20) compression = view.getUint32(30, true);
    if (dibSize >= 40) {
      xppm = view.getInt32(38, true);
      colorsUsed = view.getUint32(46, true);
    }
    if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
      const hasAlphaMask = compression === BI_ALPHABITFIELDS || dibSize >= 56;
      if (input.length < 14 + 40 + (hasAlphaMask ? 16 : 12)) throw new BmpError('Cabecera BMP incompleta.');
      masks = [
        makeMask(view.getUint32(54, true)),
        makeMask(view.getUint32(58, true)),
        makeMask(view.getUint32(62, true)),
        makeMask(hasAlphaMask ? view.getUint32(66, true) : 0),
      ];
      if (dibSize === 40) afterHeader += compression === BI_ALPHABITFIELDS ? 16 : 12;
    }
  } else {
    throw new BmpError('Cabecera BMP no reconocida.');
  }

  if (compression === BI_JPEG || compression === BI_PNG) {
    throw new BmpError('Este BMP contiene datos JPEG/PNG incrustados, que no están soportados.');
  }
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0) throw new BmpError('Dimensiones BMP no válidas.');
  if (width * height > MAX_PIXELS) throw new BmpError('La imagen BMP es demasiado grande.');
  if (![1, 2, 4, 8, 16, 24, 32].includes(bpp)) throw new BmpError(`Profundidad de color no soportada: ${bpp} bits.`);
  if (compression === BI_RLE8 && bpp !== 8) throw new BmpError('RLE8 requiere 8 bits por píxel.');
  if (compression === BI_RLE4 && bpp !== 4) throw new BmpError('RLE4 requiere 4 bits por píxel.');
  if (![BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS, BI_ALPHABITFIELDS].includes(compression)) {
    throw new BmpError(`Compresión BMP no soportada (${compression}).`);
  }
  if (pixelOffset >= input.length) throw new BmpError('El BMP no contiene datos de píxeles.');

  // Paleta
  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    const maxColors = 1 << bpp;
    const count = colorsUsed > 0 && colorsUsed <= maxColors ? colorsUsed : maxColors;
    palette = new Uint8Array(maxColors * 4);
    for (let i = 0; i < count; i++) {
      const off = afterHeader + i * paletteEntrySize;
      if (off + 3 > input.length) break;
      palette[i * 4] = input[off + 2] as number;
      palette[i * 4 + 1] = input[off + 1] as number;
      palette[i * 4 + 2] = input[off] as number;
      palette[i * 4 + 3] = 255;
    }
  }

  const out = new Uint8Array(width * height * 4);
  const dpi = xppm > 0 ? Math.round(xppm * 0.0254) : null;

  if (compression === BI_RLE8 || compression === BI_RLE4) {
    decodeRle(input, pixelOffset, width, height, bpp, palette as Uint8Array, out, topDown);
    return { width, height, data: out, hasAlpha: hasTransparency(out), dpi };
  }

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  if (pixelOffset + rowSize * (height - 1) + Math.ceil((bpp * width) / 8) > input.length) {
    throw new BmpError('El BMP está truncado.');
  }

  if (bpp === 16 && !masks) {
    masks = [makeMask(0x7c00), makeMask(0x03e0), makeMask(0x001f), makeMask(0)];
  }
  let alphaSeen = false;
  const alphaFromReserved = bpp === 32 && !masks;

  for (let row = 0; row < height; row++) {
    const src = pixelOffset + row * rowSize;
    const y = topDown ? row : height - 1 - row;
    let dst = y * width * 4;
    if (bpp <= 8) {
      const pal = palette as Uint8Array;
      const perByte = 8 / bpp;
      const valueMask = (1 << bpp) - 1;
      for (let x = 0; x < width; x++) {
        const byte = input[src + Math.floor(x / perByte)] as number;
        const shift = 8 - bpp * ((x % perByte) + 1);
        const idx = ((byte >> shift) & valueMask) * 4;
        out[dst++] = pal[idx] as number;
        out[dst++] = pal[idx + 1] as number;
        out[dst++] = pal[idx + 2] as number;
        out[dst++] = 255;
      }
    } else if (bpp === 24) {
      for (let x = 0; x < width; x++) {
        const p = src + x * 3;
        out[dst++] = input[p + 2] as number;
        out[dst++] = input[p + 1] as number;
        out[dst++] = input[p] as number;
        out[dst++] = 255;
      }
    } else if (bpp === 32 && alphaFromReserved) {
      for (let x = 0; x < width; x++) {
        const p = src + x * 4;
        out[dst++] = input[p + 2] as number;
        out[dst++] = input[p + 1] as number;
        out[dst++] = input[p] as number;
        const a = input[p + 3] as number;
        if (a !== 0) alphaSeen = true;
        out[dst++] = a;
      }
    } else {
      const [r, g, b, a] = masks as [Mask, Mask, Mask, Mask];
      for (let x = 0; x < width; x++) {
        const value = bpp === 16 ? view.getUint16(src + x * 2, true) : view.getUint32(src + x * 4, true);
        out[dst++] = readMasked(value, r);
        out[dst++] = readMasked(value, g);
        out[dst++] = readMasked(value, b);
        if (a.bits > 0) {
          const av = readMasked(value, a);
          if (av !== 0) alphaSeen = true;
          out[dst++] = av;
        } else {
          out[dst++] = 255;
        }
      }
    }
  }

  // Muchos programas escriben 0 en el byte «reservado» o en el canal alfa: si todo el canal es 0,
  // la imagen se considera opaca (mismo criterio que los navegadores).
  const usesAlphaChannel = alphaFromReserved || (masks !== null && (masks[3] as Mask).bits > 0);
  if (usesAlphaChannel && !alphaSeen) {
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }
  return { width, height, data: out, hasAlpha: hasTransparency(out), dpi };
}

function decodeRle(
  input: Uint8Array,
  offset: number,
  width: number,
  height: number,
  bpp: number,
  palette: Uint8Array,
  out: Uint8Array,
  topDown: boolean,
): void {
  // Los píxeles que el RLE no define quedan transparentes (out ya está a cero).
  let x = 0;
  let row = 0;
  let p = offset;
  const put = (index: number): void => {
    if (x < width && row < height) {
      const y = topDown ? row : height - 1 - row;
      const d = (y * width + x) * 4;
      const s = index * 4;
      out[d] = palette[s] as number;
      out[d + 1] = palette[s + 1] as number;
      out[d + 2] = palette[s + 2] as number;
      out[d + 3] = 255;
    }
    x++;
  };
  while (p + 1 < input.length && row < height) {
    const count = input[p++] as number;
    const value = input[p++] as number;
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        if (bpp === 8) put(value);
        else put(i % 2 === 0 ? value >> 4 : value & 0x0f);
      }
      continue;
    }
    if (value === 0) {
      x = 0;
      row++;
    } else if (value === 1) {
      return;
    } else if (value === 2) {
      if (p + 1 >= input.length) return;
      x += input[p++] as number;
      row += input[p++] as number;
    } else {
      const n = value;
      if (bpp === 8) {
        for (let i = 0; i < n; i++) put(input[p + i] as number);
        p += n + (n % 2);
      } else {
        const bytes = Math.ceil(n / 2);
        for (let i = 0; i < n; i++) {
          const byte = input[p + (i >> 1)] as number;
          put(i % 2 === 0 ? byte >> 4 : byte & 0x0f);
        }
        p += bytes + (bytes % 2);
      }
    }
  }
}

function hasTransparency(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] as number) < 255) return true;
  }
  return false;
}

/**
 * Codifica RGBA como BMP. Sin transparencia: 24 bits con cabecera clásica (máxima compatibilidad).
 * Con transparencia: 32 bits BI_BITFIELDS con cabecera V4 y máscara alfa; los píxeles totalmente
 * transparentes se guardan en blanco para que los visores que ignoran el alfa muestren un fondo limpio.
 */
export function encodeBmp(image: { width: number; height: number; data: Uint8Array; dpi?: number | null }): Uint8Array {
  const { width, height, data } = image;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    throw new BmpError('Datos de imagen no válidos para BMP.');
  }
  const alpha = hasTransparency(data);
  const bpp = alpha ? 32 : 24;
  const dibSize = alpha ? 108 : 40;
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const imageSize = rowSize * height;
  const pixelOffset = 14 + dibSize;
  const fileSize = pixelOffset + imageSize;
  if (fileSize > 0xffffffff) throw new BmpError('La imagen es demasiado grande para BMP.');

  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);
  const dpi = image.dpi && image.dpi > 0 ? image.dpi : 96;
  const ppm = Math.round(dpi / 0.0254);

  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(2, fileSize, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, dibSize, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positivo: filas de abajo arriba
  view.setUint16(26, 1, true);
  view.setUint16(28, bpp, true);
  view.setUint32(30, alpha ? BI_BITFIELDS : BI_RGB, true);
  view.setUint32(34, imageSize, true);
  view.setInt32(38, ppm, true);
  view.setInt32(42, ppm, true);
  view.setUint32(46, 0, true);
  view.setUint32(50, 0, true);
  if (alpha) {
    view.setUint32(54, 0x00ff0000, true); // R
    view.setUint32(58, 0x0000ff00, true); // G
    view.setUint32(62, 0x000000ff, true); // B
    view.setUint32(66, 0xff000000, true); // A
    view.setUint32(70, 0x73524742, true); // LCS_sRGB ('sRGB')
  }

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    let dst = pixelOffset + y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const a = data[s + 3] as number;
      if (alpha) {
        if (a === 0) {
          out[dst++] = 255;
          out[dst++] = 255;
          out[dst++] = 255;
        } else {
          out[dst++] = data[s + 2] as number;
          out[dst++] = data[s + 1] as number;
          out[dst++] = data[s] as number;
        }
        out[dst++] = a;
      } else {
        out[dst++] = data[s + 2] as number;
        out[dst++] = data[s + 1] as number;
        out[dst++] = data[s] as number;
      }
    }
  }
  return out;
}

/** Lee solo la cabecera para validar un BMP escrito (dimensiones y profundidad). */
export function readBmpHeader(input: Uint8Array): { width: number; height: number; bpp: number } {
  if (input.length < 30 || input[0] !== 0x42 || input[1] !== 0x4d) throw new BmpError('No es un archivo BMP válido.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const dibSize = view.getUint32(14, true);
  if (dibSize === 12) {
    return { width: view.getUint16(18, true), height: Math.abs(view.getInt16(20, true)), bpp: view.getUint16(24, true) };
  }
  return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)), bpp: view.getUint16(28, true) };
}
