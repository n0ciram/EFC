/**
 * Conversiones de imagen con archivos reales: se comprueba el archivo producido, no la interfaz.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { decodeBmp } from '../../electron/conversion/adapters/bmp-codec';
import { readIcoDirectory } from '../../electron/conversion/adapters/ico-codec';
import { loadSharp } from '../../electron/conversion/adapters/image';
import { runJob, type JobResult } from '../../electron/conversion/engine';
import type { FormatId, TargetId } from '../../src/types/formats';
import { listFiles, makeAnimatedGif, makeMultiPageTiff, makePng, makeRotatedJpeg, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

const noop = (): void => undefined;

async function convert(target: TargetId, files: { path: string; format: FormatId }[]): Promise<JobResult> {
  return runJob(spec(target, files), noop, new AbortController().signal);
}

describe('Conversiones de imagen (archivos reales)', () => {
  let dir = '';
  let png = '';
  let jpg = '';

  before(async () => {
    // Las comprobaciones abren los resultados por ruta: sin caché, libvips no los deja abiertos y
    // Windows permite borrar la carpeta al terminar.
    (await loadSharp()).cache(false);
    dir = await makeTempDir('imagenes');
    png = path.join(dir, 'logo con espacios ñ.png');
    jpg = path.join(dir, 'foto girada.jpg');
    await makePng(png);
    await makeRotatedJpeg(jpg);
  });
  after(async () => {
    await removeDir(dir);
  });

  const formatsBySharp: [TargetId, string][] = [
    ['jpg', 'jpeg'],
    ['webp', 'webp'],
    ['avif', 'heif'],
    ['tiff', 'tiff'],
    ['gif', 'gif'],
  ];

  for (const [target, sharpFormat] of formatsBySharp) {
    it(`PNG → ${target.toUpperCase()} produce un archivo válido con las mismas dimensiones`, async () => {
      const before = await sha256(png);
      const result = await convert(target, [{ path: png, format: 'png' }]);
      assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
      const out = result.outputs[0]?.output as string;
      assert.equal(path.basename(out), `logo con espacios ñ.${target === 'jpg' ? 'jpg' : target === 'tiff' ? 'tif' : target}`);
      const sharp = await loadSharp();
      const meta = await sharp(out).metadata();
      assert.equal(meta.format, sharpFormat);
      assert.equal(meta.width, 320);
      assert.equal(meta.height, 200);
      assert.equal(await sha256(png), before, 'el original no debe cambiar');
    });
  }

  it('PNG → JPG rellena la transparencia en blanco y PNG → WEBP la conserva', async () => {
    const sharp = await loadSharp();
    const jpgOut = path.join(dir, 'logo con espacios ñ.jpg');
    const px = await sharp(jpgOut).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer();
    assert.ok((px[0] as number) > 245 && (px[1] as number) > 245 && (px[2] as number) > 245, `esperado blanco, recibido ${[...px]}`);
    const webpMeta = await sharp(path.join(dir, 'logo con espacios ñ.webp')).metadata();
    assert.equal(webpMeta.hasAlpha, true);
  });

  it('PNG → BMP escribe un BMP de 32 bits legible con alfa', async () => {
    const result = await convert('bmp', [{ path: png, format: 'png' }]);
    const out = result.outputs[0]?.output as string;
    const decoded = decodeBmp(await fs.readFile(out));
    assert.equal(decoded.width, 320);
    assert.equal(decoded.height, 200);
    assert.equal(decoded.hasAlpha, true);
    // Píxel visible (x=200, y=100) idéntico al original.
    const sharp = await loadSharp();
    const orig = await sharp(png).extract({ left: 200, top: 100, width: 1, height: 1 }).raw().toBuffer();
    const i = (100 * 320 + 200) * 4;
    assert.deepEqual([...decoded.data.slice(i, i + 4)], [...orig]);
  });

  it('BMP → PNG conserva los píxeles exactos', async () => {
    const bmp = path.join(dir, 'logo con espacios ñ.bmp');
    const result = await convert('png', [{ path: bmp, format: 'bmp' }]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0]?.output as string;
    assert.equal(path.basename(out), 'logo con espacios ñ_converted.png', 'el PNG original ya existe: no se sobrescribe');
    const sharp = await loadSharp();
    const a = await sharp(png).raw().toBuffer();
    const b = await sharp(out).ensureAlpha().raw().toBuffer();
    // Los píxeles totalmente transparentes pueden cambiar de color (se guardan en blanco); el resto, idénticos.
    let diffs = 0;
    for (let p = 0; p < a.length; p += 4) {
      if (a[p + 3] === 0 && b[p + 3] === 0) continue;
      if (a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2] || a[p + 3] !== b[p + 3]) diffs++;
    }
    assert.equal(diffs, 0);
  });

  it('PNG → ICO genera un icono con los tamaños estándar', async () => {
    const result = await convert('ico', [{ path: png, format: 'png' }]);
    const out = result.outputs[0]?.output as string;
    const entries = readIcoDirectory(await fs.readFile(out));
    assert.deepEqual(entries.map((e) => e.size), [16, 24, 32, 48, 64, 128, 256]);
    assert.ok(entries.every((e) => e.isPng));
  });

  it('JPG con orientación EXIF → PNG aplica el giro (400×200 almacenado → 200×400 visible)', async () => {
    const result = await convert('png', [{ path: jpg, format: 'jpg' }]);
    const out = result.outputs[0]?.output as string;
    const sharp = await loadSharp();
    const meta = await sharp(out).metadata();
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 400);
    // Con orientación 6 la mitad izquierda almacenada (roja) queda arriba.
    const top = await sharp(out).extract({ left: 100, top: 20, width: 1, height: 1 }).raw().toBuffer();
    assert.ok((top[0] as number) > 150 && (top[2] as number) < 100, `arriba debería ser rojo: ${[...top]}`);
  });

  it('TIFF multipágina → PNG crea una carpeta con una imagen por página', async () => {
    const tiff = path.join(dir, 'escaneo.tiff');
    await makeMultiPageTiff(tiff, 3);
    const result = await convert('png', [{ path: tiff, format: 'tiff' }]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const output = result.outputs[0];
    assert.equal(output?.kind, 'folder');
    assert.equal(path.basename(output?.output as string), 'escaneo (PNG)');
    assert.deepEqual(await listFiles(output?.output as string), ['escaneo-01.png', 'escaneo-02.png', 'escaneo-03.png']);
  });

  it('GIF animado → WEBP conserva la animación; → PNG toma el primer fotograma', async () => {
    const gif = path.join(dir, 'animación.gif');
    await makeAnimatedGif(gif);
    const sharp = await loadSharp();
    const webp = await convert('webp', [{ path: gif, format: 'gif' }]);
    const webpMeta = await sharp(webp.outputs[0]?.output as string).metadata();
    assert.equal(webpMeta.pages, 3);
    const pngResult = await convert('png', [{ path: gif, format: 'gif' }]);
    const pngMeta = await sharp(pngResult.outputs[0]?.output as string).metadata();
    assert.equal(pngMeta.width, 64);
    assert.equal(pngMeta.height, 48);
  });

  it('SVG → PNG rasteriza con un tamaño mínimo cómodo y mantiene la proporción', async () => {
    const svg = path.join(dir, 'icono.svg');
    await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#08f"/></svg>');
    const result = await convert('png', [{ path: svg, format: 'svg' }]);
    const sharp = await loadSharp();
    const meta = await sharp(result.outputs[0]?.output as string).metadata();
    assert.equal(meta.width, 1024);
    assert.equal(meta.height, 512);
  });

  it('un lote informa de cada archivo y sigue tras un error', async () => {
    const broken = path.join(dir, 'dañado.png');
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
    await fs.writeFile(broken, header);
    const updates: (number | null)[] = [];
    const result = await runJob(
      spec('webp', [
        { path: broken, format: 'png' },
        { path: png, format: 'png' },
      ]),
      (u) => updates.push(u.overall),
      new AbortController().signal,
    );
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.code, 'corrupt');
    assert.equal(result.outputs.length, 1);
    assert.ok(updates.includes(1), 'el progreso del lote llega al 100 %');
    const leftovers = (await fs.readdir(dir)).filter((n) => n.startsWith('.~efc-'));
    assert.deepEqual(leftovers, [], 'no deben quedar temporales');
    assert.ok(!(await fs.readdir(dir)).includes('dañado.webp'), 'no se crea un archivo vacío para el que falló');
  });

  it('un archivo con extensión equivocada se rechaza si su contenido cambió', async () => {
    const fake = path.join(dir, 'no es una imagen.png');
    await fs.writeFile(fake, 'texto plano');
    const result = await convert('jpg', [{ path: fake, format: 'png' }]);
    assert.equal(result.failures[0]?.code, 'changed');
  });

  it('omite los archivos que ya están en el formato de destino', async () => {
    const result = await convert('png', [{ path: png, format: 'png' }]);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.outputs.length, 0);
  });
});
