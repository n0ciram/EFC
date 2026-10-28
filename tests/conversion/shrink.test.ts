/**
 * «Reducir» con archivos reales: se comprueban dimensiones, formato, peso, transparencia, animación,
 * páginas, metadatos eliminados y que no se crea nada si no se ahorra espacio.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { probeMedia } from '../../electron/conversion/adapters/ffmpeg';
import { loadSharp } from '../../electron/conversion/adapters/image';
import { runJob, type JobResult } from '../../electron/conversion/engine';
import type { FfmpegCaps } from '../../electron/conversion/registry';
import type { FormatId } from '../../src/types/formats';
import { ffmpegCaps, listFiles, makePng, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

const noop = (): void => undefined;

async function noisy(width: number, height: number, sigma = 28) {
  const sharp = await loadSharp();
  return sharp({ create: { width, height, channels: 3, background: '#7a8ca0', noise: { type: 'gaussian', mean: 128, sigma } } });
}

describe('Reducir tamaño (archivos reales)', async () => {
  const caps = await ffmpegCaps();
  let dir = '';
  const file = (name: string): string => path.join(dir, name);
  const shrink = (name: string, format: FormatId): Promise<JobResult> =>
    runJob(spec('shrink', [{ path: file(name), format }], caps), noop, new AbortController().signal);

  before(async () => {
    dir = await makeTempDir('reducir');
    // Foto grande con EXIF y ubicación GPS.
    await (await noisy(4000, 3000))
      .withExif({ IFD0: { Copyright: 'EFC prueba' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 28/1 0/1' } })
      .jpeg({ quality: 95 })
      .toFile(file('foto del móvil.jpg'));
    // Foto apaisada guardada con orientación EXIF 6 (se ve en vertical).
    await (await noisy(3000, 2000)).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toFile(file('girada.jpg'));
    await makePng(file('captura con transparencia.png'), 2600, 1700);
    // Captura de pantalla: pocos colores planos y texto, con sombras suaves (antialias).
    const shot = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="2560" height="1440"><rect width="100%" height="100%" fill="#f3f3f3"/>` +
        Array.from({ length: 40 }, (_, i) => `<rect x="${60 + (i % 5) * 480}" y="${80 + Math.floor(i / 5) * 160}" width="420" height="120" rx="12" fill="${['#ffffff', '#e8eef7', '#fff4e5'][i % 3]}" stroke="#c9ced6"/><text x="${90 + (i % 5) * 480}" y="${150 + Math.floor(i / 5) * 160}" font-family="Arial" font-size="28" fill="#222">Pedido ${1000 + i} · Valencia</text>`).join('') +
        '</svg>',
    );
    await (await loadSharp())(shot).png({ compressionLevel: 6 }).toFile(file('captura de pantalla.png'));
    await (await noisy(200, 150)).jpeg({ quality: 50 }).toFile(file('ya pequeña.jpg'));
    const sharp = await loadSharp();
    const frames = await Promise.all([0, 1, 2].map(async (i) => (await noisy(2200, 1500, 10 + i * 4)).png().toBuffer()));
    await sharp(frames, { join: { animated: true } }).gif({ delay: [200, 200, 200], loop: 0 }).toFile(file('animación.gif'));
    const pages = await Promise.all([0, 1].map(async () => (await noisy(2400, 1800, 12)).png().toBuffer()));
    await sharp(pages, { join: { animated: true } }).tiff({ compression: 'lzw' }).toFile(file('escaneo.tiff'));
    // BMP de 32 bits con transparencia, creado con la propia conversión de EFC.
    await makePng(file('origen bmp.png'), 1800, 1200);
    const bmp = await runJob(spec('bmp', [{ path: file('origen bmp.png'), format: 'png' }]), noop, new AbortController().signal);
    assert.equal(bmp.failures.length, 0);
  });
  after(async () => {
    await removeDir(dir);
  });

  it('una foto de 12 MP baja a 1920 px, pesa mucho menos y pierde la ubicación GPS', async () => {
    const before = await sha256(file('foto del móvil.jpg'));
    const result = await shrink('foto del móvil.jpg', 'jpg');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0];
    assert.equal(path.basename(out?.output as string), 'foto del móvil_reducido.jpg');
    const meta = await (await loadSharp())(out?.output as string).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1920, 1440]);
    assert.equal(meta.exif, undefined, 'no deben quedar datos EXIF ni GPS');
    assert.ok((out?.outputBytes as number) < (out?.inputBytes as number) * 0.4, `${out?.inputBytes} → ${out?.outputBytes}`);
    assert.equal((await fs.stat(out?.output as string)).size, out?.outputBytes);
    assert.equal(await sha256(file('foto del móvil.jpg')), before, 'el original no cambia');
  });

  it('aplica la orientación EXIF: la foto girada sale en vertical', async () => {
    const result = await shrink('girada.jpg', 'jpg');
    const meta = await (await loadSharp())(result.outputs[0]?.output as string).metadata();
    assert.deepEqual([meta.width, meta.height], [1280, 1920]);
    assert.equal(meta.orientation, undefined);
  });

  it('un PNG con transparencia sigue siendo PNG con transparencia', async () => {
    const result = await shrink('captura con transparencia.png', 'png');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const meta = await (await loadSharp())(result.outputs[0]?.output as string).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 1920);
    assert.ok(meta.hasAlpha, 'debe conservar la transparencia');
    assert.ok((result.outputs[0]?.outputBytes as number) < (result.outputs[0]?.inputBytes as number));
  });

  it('un GIF animado sigue animado, con todos sus fotogramas', async () => {
    const result = await shrink('animación.gif', 'gif');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const meta = await (await loadSharp())(result.outputs[0]?.output as string, { animated: true }).metadata();
    assert.equal(meta.format, 'gif');
    assert.equal(meta.pages, 3);
    assert.equal(meta.width, 1920);
  });

  it('una captura de pantalla PNG se queda con paleta de colores (mucho más ligera)', async () => {
    const result = await shrink('captura de pantalla.png', 'png');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const meta = await (await loadSharp())(result.outputs[0]?.output as string).metadata();
    assert.ok(meta.isPalette, 'debe usar paleta');
    assert.ok((result.outputs[0]?.outputBytes as number) < (result.outputs[0]?.inputBytes as number) * 0.6);
  });

  it('un TIFF de varias páginas conserva todas las páginas', async () => {
    const result = await shrink('escaneo.tiff', 'tiff');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    assert.equal(path.extname(result.outputs[0]?.output as string), '.tif');
    const meta = await (await loadSharp())(result.outputs[0]?.output as string).metadata();
    assert.equal(meta.pages, 2);
    assert.equal(meta.width, 1920);
  });

  it('un BMP con transparencia se guarda como PNG (el correo no muestra BMP)', async () => {
    const result = await shrink('origen bmp.bmp', 'bmp');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    assert.equal(path.basename(result.outputs[0]?.output as string), 'origen bmp_reducido.png');
  });

  it('si ya ocupa poco no crea ningún archivo y lo explica', async () => {
    const before = await listFiles(dir);
    const result = await shrink('ya pequeña.jpg', 'jpg');
    assert.equal(result.outputs.length, 0);
    assert.equal(result.failures.length, 0);
    assert.match(result.skipped[0]?.reason ?? '', /Ya ocupa poco/);
    assert.deepEqual(await listFiles(dir), before, 'sin salidas ni temporales');
  });

  it('reducir dos veces no sobrescribe: crea «_reducido_converted»', async () => {
    const result = await shrink('foto del móvil.jpg', 'jpg');
    assert.equal(path.basename(result.outputs[0]?.output as string), 'foto del móvil_reducido_converted.jpg');
  });

  describe('vídeo', { skip: caps ? false : 'FFmpeg no está disponible en este equipo' }, () => {
    const make = (name: string, size: string): void => {
      const r = spawnSync(
        (caps as FfmpegCaps).path,
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=4`, '-f', 'lavfi', '-i', 'sine=frequency=500:duration=4',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-metadata', 'title=Secreto de prueba', '-metadata', 'location=+39.4699-000.3763/', file(name)],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) throw new Error(r.stderr);
    };

    it('un vídeo Full HD pasa a un MP4 720p mucho más ligero, con audio y sin metadatos', async () => {
      make('vídeo full hd.mp4', '1920x1080');
      const result = await shrink('vídeo full hd.mp4', 'mp4');
      assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
      const out = result.outputs[0]?.output as string;
      assert.equal(path.basename(out), 'vídeo full hd_reducido.mp4');
      const info = await probeMedia((caps as FfmpegCaps).path, out);
      assert.deepEqual([info.video?.codec, info.video?.width, info.video?.height], ['h264', 1280, 720]);
      assert.equal(info.audio?.codec, 'aac');
      assert.ok((result.outputs[0]?.outputBytes as number) < (result.outputs[0]?.inputBytes as number) * 0.5);
      const probe = spawnSync((caps as FfmpegCaps).path, ['-hide_banner', '-i', out], { encoding: 'utf8' });
      assert.ok(!probe.stderr.includes('Secreto') && !probe.stderr.includes('+39.4699'), 'no deben quedar título ni ubicación');
    });

    it('un vídeo vertical del móvil mantiene la proporción (720×1280)', async () => {
      make('vertical.mp4', '1080x1920');
      const result = await shrink('vertical.mp4', 'mp4');
      const info = await probeMedia((caps as FfmpegCaps).path, result.outputs[0]?.output as string);
      assert.deepEqual([info.video?.width, info.video?.height], [720, 1280]);
    });
  });
});
