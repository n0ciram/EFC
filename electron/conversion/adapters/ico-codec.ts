/**
 * Escritura de iconos de Windows (.ico) con entradas comprimidas en PNG (Windows Vista y posteriores).
 */

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export interface IcoEntry {
  size: number;
  png: Uint8Array;
}

export function encodeIco(entries: readonly IcoEntry[]): Uint8Array {
  if (entries.length === 0 || entries.length > 255) throw new Error('Número de entradas ICO no válido.');
  const headerSize = 6 + entries.length * 16;
  const total = headerSize + entries.reduce((sum, e) => sum + e.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reservado
  view.setUint16(2, 1, true); // tipo: icono
  view.setUint16(4, entries.length, true);

  let offset = headerSize;
  entries.forEach((entry, i) => {
    if (entry.size < 1 || entry.size > 256) throw new Error('Tamaño de icono no válido.');
    const dir = 6 + i * 16;
    out[dir] = entry.size === 256 ? 0 : entry.size;
    out[dir + 1] = entry.size === 256 ? 0 : entry.size;
    out[dir + 2] = 0; // colores de paleta
    out[dir + 3] = 0; // reservado
    view.setUint16(dir + 4, 1, true); // planos
    view.setUint16(dir + 6, 32, true); // bits por píxel
    view.setUint32(dir + 8, entry.png.length, true);
    view.setUint32(dir + 12, offset, true);
    out.set(entry.png, offset);
    offset += entry.png.length;
  });
  return out;
}

/** Lee el directorio de un ICO (para verificar el resultado). */
export function readIcoDirectory(input: Uint8Array): { size: number; bytes: number; offset: number; isPng: boolean }[] {
  if (input.length < 6) throw new Error('ICO demasiado corto.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) throw new Error('No es un archivo ICO.');
  const count = view.getUint16(4, true);
  const result: { size: number; bytes: number; offset: number; isPng: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const dir = 6 + i * 16;
    if (dir + 16 > input.length) throw new Error('Directorio ICO truncado.');
    const size = (input[dir] as number) || 256;
    const bytes = view.getUint32(dir + 8, true);
    const offset = view.getUint32(dir + 12, true);
    if (offset + bytes > input.length) throw new Error('Entrada ICO truncada.');
    const isPng = input[offset] === 0x89 && input[offset + 1] === 0x50 && input[offset + 2] === 0x4e && input[offset + 3] === 0x47;
    result.push({ size, bytes, offset, isPng });
  }
  return result;
}
