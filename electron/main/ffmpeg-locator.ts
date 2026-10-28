/**
 * Localiza FFmpeg y comprueba sus codificadores.
 *
 * Orden: ruta configurada → FFmpeg incluido con EFC (carpeta `resources\ffmpeg` de la instalación;
 * en desarrollo, el paquete ffmpeg-static) → FFmpeg del PATH → ubicaciones habituales (winget,
 * C:\ffmpeg). Si no hay ninguno, el audio y el vídeo no se ofrecen.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectFfmpeg } from '../conversion/adapters/ffmpeg';
import { unpackedPath } from '../conversion/asar';
import type { FfmpegCaps } from '../conversion/registry';
import { createLogger } from './logger';

const log = createLogger('ffmpeg');
const localRequire = createRequire(__filename);

interface Candidate {
  path: string;
  source: FfmpegCaps['source'];
}

function bundledFfmpeg(): string | null {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const packaged = path.join(process.resourcesPath, 'ffmpeg', exe);
    return existsSync(packaged) ? packaged : null;
  }
  try {
    const p = localRequire('ffmpeg-static') as string | null;
    return p ? unpackedPath(p) : null;
  } catch {
    return null;
  }
}

function pathCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'));
    dirs.push('C:\\ffmpeg\\bin');
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'ffmpeg', 'bin'));
  }
  return dirs.map((d) => path.join(d.replace(/^"|"$/g, ''), exe));
}

export async function locateFfmpeg(configured: string | null): Promise<FfmpegCaps | null> {
  const candidates: Candidate[] = [];
  if (configured) candidates.push({ path: configured, source: 'config' });
  const bundled = bundledFfmpeg();
  if (bundled) candidates.push({ path: bundled, source: 'bundled' });
  for (const p of pathCandidates()) candidates.push({ path: p, source: 'path' });

  const tried = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase();
    if (tried.has(key) || !existsSync(candidate.path)) continue;
    tried.add(key);
    try {
      const caps = await inspectFfmpeg(candidate.path, candidate.source);
      log.info(`FFmpeg ${caps.version} (${candidate.source}): ${candidate.path} — ${caps.encoders.size} codificadores`);
      return caps;
    } catch (err) {
      log.warn(`FFmpeg no utilizable en ${candidate.path}`, err);
    }
  }
  log.warn('FFmpeg no está disponible: no se ofrecerán conversiones de audio ni vídeo.');
  return null;
}
