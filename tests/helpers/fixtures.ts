/**
 * Utilidades de prueba: carpetas temporales con nombres difíciles y archivos de ejemplo reales.
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { JobSpec } from '../../electron/conversion/engine';
import { inspectFfmpeg } from '../../electron/conversion/adapters/ffmpeg';
import { loadSharp } from '../../electron/conversion/adapters/image';
import { DEFAULT_CONVERSION_SETTINGS } from '../../electron/conversion/settings';
import type { FfmpegCaps } from '../../electron/conversion/registry';
import type { FormatId, TargetId } from '../../src/types/formats';

const localRequire = createRequire(__filename);

/** Carpeta temporal cuyo nombre incluye espacios, tildes y otros caracteres especiales. */
export async function makeTempDir(label: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'efc-test-'));
  const dir = path.join(base, `${label} — carpeta con espacios, ñ y acentos (á é í ó ú) & #1`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
}

export async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

export async function listFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).sort();
}

let jobCounter = 0;
export function spec(target: TargetId, files: { path: string; format: FormatId }[], ffmpeg: FfmpegCaps | null = null): JobSpec {
  jobCounter++;
  return {
    id: `t${process.pid}x${jobCounter}`,
    target,
    files,
    settings: { ...DEFAULT_CONVERSION_SETTINGS },
    ffmpeg: ffmpeg ? { path: ffmpeg.path, version: ffmpeg.version, encoders: [...ffmpeg.encoders] } : null,
  };
}

/** PNG con degradado y una zona transparente. */
export async function makePng(file: string, width = 320, height = 200): Promise<void> {
  const sharp = await loadSharp();
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((x / width) * 255);
      data[i + 1] = Math.round((y / height) * 255);
      data[i + 2] = 128;
      data[i + 3] = x < width / 4 ? 0 : 255; // franja izquierda transparente
    }
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
}

/** JPEG apaisado almacenado con orientación EXIF 6 (se ve en vertical). */
export async function makeRotatedJpeg(file: string): Promise<void> {
  const sharp = await loadSharp();
  // Mitad izquierda roja, mitad derecha azul (en la imagen almacenada de 400×200).
  const width = 400;
  const height = 200;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const left = x < width / 2;
      data[i] = left ? 220 : 20;
      data[i + 1] = 20;
      data[i + 2] = left ? 20 : 220;
    }
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).withMetadata({ orientation: 6, density: 150 }).jpeg({ quality: 92 }).toFile(file);
}

export async function makeMultiPageTiff(file: string, pages = 3): Promise<void> {
  const sharp = await loadSharp();
  const colors = ['#d33', '#3d3', '#33d', '#dd3', '#3dd'];
  const buffers = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      sharp({ create: { width: 120, height: 90, channels: 3, background: colors[i % colors.length] as string } }).png().toBuffer(),
    ),
  );
  await sharp(buffers, { join: { animated: true } }).tiff({ compression: 'lzw' }).toFile(file);
}

export async function makeAnimatedGif(file: string): Promise<void> {
  const sharp = await loadSharp();
  const frames = await Promise.all(
    ['#e33', '#3e3', '#33e'].map((c) => sharp({ create: { width: 64, height: 48, channels: 4, background: c } }).png().toBuffer()),
  );
  await sharp(frames, { join: { animated: true } }).gif({ delay: [120, 120, 120], loop: 0 }).toFile(file);
}

export async function makePdf(file: string, pages: number, landscapeEvery = 0): Promise<void> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const landscape = landscapeEvery > 0 && i % landscapeEvery === 0;
    const page = doc.addPage(landscape ? [842, 595] : [595, 842]);
    page.drawText(`Pagina ${i} de prueba EFC`, { x: 50, y: page.getHeight() - 80, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawRectangle({ x: 50, y: 100, width: 150, height: 150, color: rgb(0.2, 0.4, 0.8) });
  }
  await fs.writeFile(file, await doc.save());
}

/** Busca FFmpeg para las pruebas: EFC_FFMPEG, ffmpeg-static o el PATH. */
export function findFfmpegPath(): string | null {
  const fromEnv = process.env.EFC_FFMPEG;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const bundled = localRequire('ffmpeg-static') as string | null;
    if (bundled && existsSync(bundled)) return bundled;
  } catch {
    // ffmpeg-static no instalado o sin binario para esta plataforma
  }
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let ffmpegCapsPromise: Promise<FfmpegCaps | null> | null = null;
export function ffmpegCaps(): Promise<FfmpegCaps | null> {
  ffmpegCapsPromise ??= (async () => {
    const p = findFfmpegPath();
    if (!p) return null;
    try {
      return await inspectFfmpeg(p, 'path');
    } catch {
      return null;
    }
  })();
  return ffmpegCapsPromise;
}

/** Genera un archivo multimedia con las fuentes sintéticas de FFmpeg (lavfi). */
export function makeMedia(ffmpeg: string, file: string, kind: 'tone' | 'video', extraArgs: string[]): void {
  const inputs =
    kind === 'tone'
      ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2']
      : ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2'];
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, ...extraArgs, file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`No se pudo generar ${file}: ${result.stderr}`);
}
