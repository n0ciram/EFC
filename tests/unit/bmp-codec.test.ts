import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BmpError, decodeBmp, encodeBmp, readBmpHeader } from '../../electron/conversion/adapters/bmp-codec';

/** Construye un BMP a mano (cabecera INFO de 40 bytes) para probar variantes que el codificador propio no genera. */
function handmadeBmp(opts: {
  width: number;
  height: number;
  bpp: number;
  compression?: number;
  palette?: number[][];
  masks?: number[];
  pixelBytes: number[];
  topDown?: boolean;
  dibSize?: number;
}): Uint8Array {
  const dibSize = opts.dibSize ?? 40;
  const paletteBytes = (opts.palette ?? []).flatMap(([r, g, b]) => [b as number, g as number, r as number, 0]);
  const maskBytes = opts.masks && dibSize === 40 ? opts.masks.flatMap((m) => [m & 255, (m >>> 8) & 255, (m >>> 16) & 255, (m >>> 24) & 255]) : [];
  const pixelOffset = 14 + dibSize + maskBytes.length + paletteBytes.length;
  const total = pixelOffset + opts.pixelBytes.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, total, true);
  v.setUint32(10, pixelOffset, true);
  v.setUint32(14, dibSize, true);
  v.setInt32(18, opts.width, true);
  v.setInt32(22, opts.topDown ? -opts.height : opts.height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, opts.bpp, true);
  v.setUint32(30, opts.compression ?? 0, true);
  v.setUint32(34, opts.pixelBytes.length, true);
  v.setUint32(46, opts.palette ? opts.palette.length : 0, true);
  if (opts.masks && dibSize >= 52) opts.masks.forEach((m, i) => v.setUint32(54 + i * 4, m >>> 0, true));
  out.set(maskBytes, 14 + dibSize);
  out.set(paletteBytes, 14 + dibSize + maskBytes.length);
  out.set(opts.pixelBytes, pixelOffset);
  return out;
}

const pixel = (img: { width: number; data: Uint8Array }, x: number, y: number): number[] => {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.slice(i, i + 4));
};

describe('Códec BMP', () => {
  it('ida y vuelta en 24 bits conserva los píxeles exactos', () => {
    const width = 5; // ancho impar: obliga a rellenar las filas
    const height = 3;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) data.set([(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, 255], i * 4);
    const bmp = encodeBmp({ width, height, data });
    assert.deepEqual(readBmpHeader(bmp), { width, height, bpp: 24 });
    const back = decodeBmp(bmp);
    assert.equal(back.hasAlpha, false);
    assert.deepEqual(Array.from(back.data), Array.from(data));
  });

  it('con transparencia escribe 32 bits con canal alfa y fondo blanco en los píxeles invisibles', () => {
    const data = new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0, 200, 100, 50, 128, 1, 2, 3, 255]);
    const bmp = encodeBmp({ width: 2, height: 2, data });
    assert.equal(readBmpHeader(bmp).bpp, 32);
    const back = decodeBmp(bmp);
    assert.equal(back.hasAlpha, true);
    assert.deepEqual(pixel(back, 0, 0), [10, 20, 30, 255]);
    assert.deepEqual(pixel(back, 1, 0), [255, 255, 255, 0]);
    assert.deepEqual(pixel(back, 0, 1), [200, 100, 50, 128]);
  });

  it('lee paletas de 1, 4 y 8 bits', () => {
    // 1 bit: 3 píxeles (negro, blanco, negro) → byte 0b01000000, fila rellena a 4 bytes.
    const one = decodeBmp(handmadeBmp({ width: 3, height: 1, bpp: 1, palette: [[0, 0, 0], [255, 255, 255]], pixelBytes: [0b01000000, 0, 0, 0] }));
    assert.deepEqual(pixel(one, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(one, 1, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixel(one, 2, 0), [0, 0, 0, 255]);

    const four = decodeBmp(handmadeBmp({ width: 2, height: 1, bpp: 4, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]], pixelBytes: [0x12, 0, 0, 0] }));
    assert.deepEqual(pixel(four, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(four, 1, 0), [0, 255, 0, 255]);

    const eight = decodeBmp(handmadeBmp({ width: 2, height: 2, bpp: 8, palette: [[9, 9, 9], [1, 2, 3], [4, 5, 6]], pixelBytes: [1, 2, 0, 0, 2, 1, 0, 0] }));
    // Filas de abajo arriba: la primera fila del archivo es la inferior.
    assert.deepEqual(pixel(eight, 0, 1), [1, 2, 3, 255]);
    assert.deepEqual(pixel(eight, 0, 0), [4, 5, 6, 255]);
  });

  it('lee 16 bits 5-6-5 con máscaras y filas de arriba abajo', () => {
    const red565 = 0xf800;
    const green565 = 0x07e0;
    const bmp = handmadeBmp({
      width: 2,
      height: 1,
      bpp: 16,
      compression: 3,
      masks: [0xf800, 0x07e0, 0x001f],
      pixelBytes: [red565 & 255, red565 >> 8, green565 & 255, green565 >> 8],
      topDown: true,
    });
    const img = decodeBmp(bmp);
    assert.deepEqual(pixel(img, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixel(img, 1, 0), [0, 255, 0, 255]);
  });

  it('trata como opaco un BMP de 32 bits cuyo byte reservado es siempre 0', () => {
    const img = decodeBmp(handmadeBmp({ width: 1, height: 1, bpp: 32, pixelBytes: [30, 20, 10, 0] }));
    assert.deepEqual(pixel(img, 0, 0), [10, 20, 30, 255]);
    assert.equal(img.hasAlpha, false);
  });

  it('descomprime RLE8 (y deja transparentes los píxeles no definidos)', () => {
    // 2 píxeles índice 1, fin de línea, 1 píxel absoluto... usamos: [2,1] [0,0] [1,2] [0,1]
    const img = decodeBmp(
      handmadeBmp({
        width: 3,
        height: 2,
        bpp: 8,
        compression: 1,
        palette: [[0, 0, 0], [255, 0, 0], [0, 0, 255]],
        pixelBytes: [2, 1, 0, 0, 1, 2, 0, 1],
      }),
    );
    // Fila inferior (y=1): rojo, rojo, sin definir
    assert.deepEqual(pixel(img, 0, 1), [255, 0, 0, 255]);
    assert.deepEqual(pixel(img, 1, 1), [255, 0, 0, 255]);
    assert.deepEqual(pixel(img, 2, 1), [0, 0, 0, 0]);
    // Fila superior (y=0): azul
    assert.deepEqual(pixel(img, 0, 0), [0, 0, 255, 255]);
  });

  it('rechaza archivos dañados con un error controlado', () => {
    assert.throws(() => decodeBmp(new Uint8Array([0x42, 0x4d, 1, 2, 3])), BmpError);
    const truncated = encodeBmp({ width: 10, height: 10, data: new Uint8Array(400).fill(255) }).slice(0, 80);
    assert.throws(() => decodeBmp(truncated), BmpError);
    const huge = handmadeBmp({ width: 100000, height: 100000, bpp: 24, pixelBytes: [0, 0, 0, 0] });
    assert.throws(() => decodeBmp(huge), /demasiado grande/);
  });
});
