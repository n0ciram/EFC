/**
 * Audio y vídeo con FFmpeg.
 *
 * - El ejecutable se lanza sin intérprete de comandos y con los argumentos en una lista, por lo que
 *   un nombre de archivo nunca puede inyectar órdenes. Las rutas se pasan con el prefijo `file:` para
 *   que FFmpeg no interprete ningún nombre como protocolo.
 * - Siempre que el códec de origen es compatible con el contenedor de destino se copia el flujo sin
 *   recodificar (instantáneo y sin pérdidas); si falla, se recodifica.
 * - El progreso es real: FFmpeg informa del tiempo procesado (`-progress`) y se divide entre la duración.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import type { FormatId } from '../../../src/types/formats';
import { ConversionError } from '../errors';
import { pickEncoder, type FfmpegCaps } from '../registry';

export type StreamKind = 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';

export interface MediaStream {
  kind: StreamKind;
  codec: string;
  /** Carátula incrustada (no es vídeo real). */
  attachedPic: boolean;
  width: number | null;
  height: number | null;
  /** Bits por muestra del audio, si FFmpeg los indica. */
  bits: number | null;
}

export interface MediaInfo {
  duration: number | null;
  streams: MediaStream[];
  video: MediaStream | null;
  audio: MediaStream | null;
}

const STREAM_RE = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*(Video|Audio|Subtitle|Data|Attachment):\s*([A-Za-z0-9_\-.]+)(.*)$/gm;
const DURATION_RE = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Interpreta la salida de `ffmpeg -i archivo` (sin salida) para conocer duración y pistas. */
export function parseProbeOutput(stderr: string): MediaInfo {
  if (!/Input #0/.test(stderr)) {
    throw new ConversionError('corrupt', lastLines(stderr));
  }
  const durationMatch = DURATION_RE.exec(stderr);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : null;

  const streams: MediaStream[] = [];
  for (const match of stderr.matchAll(STREAM_RE)) {
    const kind = (match[1] as string).toLowerCase() as StreamKind;
    const rest = match[3] ?? '';
    const dims = /\b(\d{2,5})x(\d{2,5})\b/.exec(rest);
    const bitsMatch = /\((\d{1,2}) bit\)/.exec(rest) ?? /,\s*s(16|24|32)p?\b/.exec(rest);
    streams.push({
      kind,
      codec: (match[2] as string).toLowerCase(),
      attachedPic: /\(attached pic\)/.test(rest),
      width: dims ? Number(dims[1]) : null,
      height: dims ? Number(dims[2]) : null,
      bits: bitsMatch ? Number(bitsMatch[1]) : null,
    });
  }
  return {
    duration: duration !== null && duration > 0 ? duration : null,
    streams,
    video: streams.find((s) => s.kind === 'video' && !s.attachedPic) ?? null,
    audio: streams.find((s) => s.kind === 'audio') ?? null,
  };
}

function lastLines(text: string, count = 6): string {
  return text.trim().split(/\r?\n/).slice(-count).join(' | ');
}

/** Ruta de entrada/salida para FFmpeg con el protocolo explícito. */
export function ffmpegPathArg(filePath: string): string {
  return `file:${filePath}`;
}

function spawnFfmpeg(ffmpegPath: string, args: string[]) {
  return spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function lowerPriority(pid: number | undefined): void {
  if (!pid) return;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // No es crítico: algunos entornos no permiten cambiar la prioridad.
  }
}

/** Ejecuta FFmpeg y devuelve la salida de error completa (FFmpeg escribe la información en stderr). */
function collect(ffmpegPath: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFfmpeg(ffmpegPath, args);
    } catch (err) {
      reject(new ConversionError('engine_unavailable', (err as Error).message));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 4_000_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_000_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new ConversionError('engine_unavailable', err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new ConversionError('cancelled'));
      else resolve({ code, stdout, stderr });
    });
  });
}

export async function probeMedia(ffmpegPath: string, filePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const { stderr } = await collect(ffmpegPath, ['-hide_banner', '-nostdin', '-i', ffmpegPathArg(filePath)], 30_000, signal);
  return parseProbeOutput(stderr);
}

/** Lista los codificadores disponibles a partir de `ffmpeg -encoders`. */
export function parseEncoders(output: string): Set<string> {
  const names = new Set<string>();
  for (const match of output.matchAll(/^\s*[VAS][A-Z.]{5}\s+(\S+)/gm)) {
    const name = match[1] as string;
    if (name !== '=') names.add(name);
  }
  return names;
}

export function parseVersion(output: string): string {
  return /ffmpeg version (\S+)/.exec(output)?.[1] ?? 'desconocida';
}

/** Comprueba un ejecutable de FFmpeg y obtiene su versión y codificadores. */
export async function inspectFfmpeg(ffmpegPath: string, source: FfmpegCaps['source']): Promise<FfmpegCaps> {
  const version = await collect(ffmpegPath, ['-hide_banner', '-version'], 10_000);
  if (version.code !== 0) throw new Error(`ffmpeg -version terminó con código ${version.code}`);
  const encoders = await collect(ffmpegPath, ['-hide_banner', '-encoders'], 10_000);
  if (encoders.code !== 0) throw new Error(`ffmpeg -encoders terminó con código ${encoders.code}`);
  return {
    path: ffmpegPath,
    version: parseVersion(version.stdout + version.stderr),
    encoders: parseEncoders(encoders.stdout + encoders.stderr),
    source,
  };
}

export interface FfmpegPlan {
  /** «copy» copia los flujos sin recodificar; «encode» recodifica. */
  mode: 'copy' | 'encode';
  args: string[];
}

const MUXERS: Partial<Record<FormatId, string>> = {
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  m4a: 'ipod',
  ogg: 'ogg',
  opus: 'ogg',
  mp4: 'mp4',
  mov: 'mov',
  webm: 'webm',
  mkv: 'matroska',
  gif: 'gif',
};

function videoBitrate(stream: MediaStream): string {
  const pixels = (stream.width ?? 1280) * (stream.height ?? 720);
  if (pixels >= 3840 * 2160) return '35M';
  if (pixels >= 2560 * 1440) return '16M';
  if (pixels >= 1920 * 1080) return '8M';
  if (pixels >= 1280 * 720) return '5M';
  return '2500k';
}

function h264Args(caps: FfmpegCaps, video: MediaStream): string[] {
  const encoder = pickEncoder(caps, 'h264');
  if (!encoder) throw new ConversionError('engine_unavailable', 'Sin codificador H.264');
  const quality = encoder === 'libx264' ? ['-preset', 'medium', '-crf', '20'] : ['-b:v', videoBitrate(video)];
  return ['-c:v', encoder, ...quality, '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'];
}

function aacArgs(caps: FfmpegCaps): string[] {
  const encoder = pickEncoder(caps, 'aac');
  if (!encoder) throw new ConversionError('engine_unavailable', 'Sin codificador AAC');
  return ['-c:a', encoder, '-b:a', '192k'];
}

function vp9Args(caps: FfmpegCaps, video: MediaStream): string[] {
  const encoder = pickEncoder(caps, 'vp9');
  if (encoder === 'libvpx-vp9') {
    return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'];
  }
  if (encoder === 'libvpx') {
    return ['-c:v', 'libvpx', '-crf', '10', '-b:v', videoBitrate(video), '-deadline', 'good', '-cpu-used', '4'];
  }
  throw new ConversionError('engine_unavailable', 'Sin codificador VP9/VP8');
}

function webmAudioArgs(caps: FfmpegCaps): string[] {
  if (pickEncoder(caps, 'opus')) return ['-c:a', 'libopus', '-b:a', '128k'];
  if (pickEncoder(caps, 'vorbis')) return ['-c:a', 'libvorbis', '-q:a', '5'];
  return ['-an'];
}

const GIF_FILTER =
  "fps=12,scale=w='min(iw,640)':h=-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4";

/**
 * Planes de conversión por orden de preferencia (el primero suele copiar sin recodificar).
 * Lanza `ConversionError` si el origen no tiene las pistas necesarias.
 */
export function planConversion(info: MediaInfo, target: FormatId, caps: FfmpegCaps, input: string, output: string): FfmpegPlan[] {
  const muxer = MUXERS[target];
  if (!muxer) throw new ConversionError('unsupported', `Sin contenedor para ${target}`);
  const head = ['-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', ffmpegPathArg(input)];
  const tail = ['-f', muxer, ffmpegPathArg(output)];
  const plan = (mode: FfmpegPlan['mode'], body: string[]): FfmpegPlan => ({ mode, args: [...head, ...body, ...tail] });

  const audioOnly = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '0'];
  const audio = info.audio;
  const video = info.video;

  switch (target) {
    case 'mp3': {
      if (!audio) throw new ConversionError('no_audio');
      const encoder = pickEncoder(caps, 'mp3');
      const quality = encoder === 'libmp3lame' ? ['-q:a', '2'] : ['-b:a', '192k'];
      return [plan('encode', [...audioOnly, '-c:a', encoder as string, ...quality, '-id3v2_version', '3'])];
    }
    case 'wav': {
      if (!audio) throw new ConversionError('no_audio');
      const codec = audio.bits !== null && audio.bits > 16 ? 'pcm_s24le' : 'pcm_s16le';
      return [plan('encode', [...audioOnly, '-c:a', codec])];
    }
    case 'flac': {
      if (!audio) throw new ConversionError('no_audio');
      return [plan('encode', [...audioOnly, '-c:a', 'flac', '-compression_level', '5'])];
    }
    case 'ogg': {
      if (!audio) throw new ConversionError('no_audio');
      return [plan('encode', [...audioOnly, '-c:a', 'libvorbis', '-q:a', '6'])];
    }
    case 'opus': {
      if (!audio) throw new ConversionError('no_audio');
      return [plan('encode', [...audioOnly, '-c:a', 'libopus', '-b:a', '160k'])];
    }
    case 'm4a': {
      if (!audio) throw new ConversionError('no_audio');
      const encode = plan('encode', [...audioOnly, ...aacArgs(caps), '-movflags', '+faststart']);
      if (audio.codec === 'aac') {
        return [plan('copy', [...audioOnly, '-c:a', 'copy', '-movflags', '+faststart']), encode];
      }
      return [encode];
    }
    case 'mp4':
    case 'mov': {
      if (!video) throw new ConversionError('unsupported', 'El archivo no contiene vídeo');
      const maps = ['-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
      const plans: FfmpegPlan[] = [];
      const videoCopyable = ['h264', 'hevc', 'av1', 'mpeg4'].includes(video.codec);
      const audioCopyable = !audio || ['aac', 'mp3', 'alac', 'ac3'].includes(audio.codec);
      if (videoCopyable && audioCopyable) {
        const tag = video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
        plans.push(plan('copy', [...maps, '-c', 'copy', ...tag, '-movflags', '+faststart']));
      }
      const audioArgs = audio ? aacArgs(caps) : ['-an'];
      plans.push(plan('encode', [...maps, ...h264Args(caps, video), ...audioArgs, '-movflags', '+faststart']));
      return plans;
    }
    case 'mkv': {
      if (!video) throw new ConversionError('unsupported', 'El archivo no contiene vídeo');
      const audioArgs = audio ? aacArgs(caps) : ['-an'];
      return [
        plan('copy', ['-map', '0:v:0', '-map', '0:a?', '-map', '0:s?', '-c', 'copy', '-map_metadata', '0']),
        plan('copy', ['-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-map_metadata', '0']),
        plan('encode', ['-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0', ...h264Args(caps, video), ...audioArgs]),
      ];
    }
    case 'webm': {
      if (!video) throw new ConversionError('unsupported', 'El archivo no contiene vídeo');
      const maps = ['-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
      const plans: FfmpegPlan[] = [];
      if (['vp8', 'vp9', 'av1'].includes(video.codec) && (!audio || ['opus', 'vorbis'].includes(audio.codec))) {
        plans.push(plan('copy', [...maps, '-c', 'copy']));
      }
      plans.push(plan('encode', [...maps, ...vp9Args(caps, video), ...(audio ? webmAudioArgs(caps) : ['-an'])]));
      return plans;
    }
    case 'gif': {
      if (!video) throw new ConversionError('unsupported', 'El archivo no contiene vídeo');
      return [plan('encode', ['-map', '0:v:0', '-an', '-sn', '-vf', GIF_FILTER, '-loop', '0'])];
    }
    default:
      throw new ConversionError('unsupported', `Destino no soportado por FFmpeg: ${target}`);
  }
}

/**
 * «Reducir» un vídeo: MP4 H.264 + AAC con el lado mayor limitado (sin ampliar), como mucho 30 fotogramas
 * por segundo y sin metadatos (los móviles guardan ahí la ubicación). La rotación del móvil se aplica.
 */
export function planShrink(info: MediaInfo, caps: FfmpegCaps, input: string, output: string, maxSide: number, crf: number): FfmpegPlan {
  const video = info.video;
  if (!video) throw new ConversionError('unsupported', 'El archivo no contiene vídeo');
  const encoder = pickEncoder(caps, 'h264');
  if (!encoder) throw new ConversionError('engine_unavailable', 'Sin codificador H.264');
  // Mismo factor para ancho y alto (conserva la proporción) y dimensiones pares, como exige H.264.
  const factor = `min(1,${maxSide}/max(iw,ih))`;
  const scale = `scale=w='trunc(iw*${factor}/2)*2':h='trunc(ih*${factor}/2)*2':flags=bicubic`;
  const quality =
    encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', String(crf), '-profile:v', 'high'] : ['-b:v', maxSide >= 1920 ? '4M' : maxSide >= 1280 ? '2M' : '1M'];
  const audio = info.audio ? [...aacArgs(caps).slice(0, 2), '-b:a', '96k', '-ac', '2'] : ['-an'];
  return {
    mode: 'encode',
    args: [
      '-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
      '-i', ffmpegPathArg(input),
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', scale, '-fpsmax', '30',
      '-c:v', encoder, ...quality, '-pix_fmt', 'yuv420p',
      ...audio,
      '-movflags', '+faststart',
      '-f', 'mp4', ffmpegPathArg(output),
    ],
  };
}

function classifyFailure(stderr: string): ConversionError {
  const text = stderr.toLowerCase();
  const detail = lastLines(stderr);
  if (text.includes('no space left')) return new ConversionError('write_failed', detail);
  if (text.includes('permission denied')) return new ConversionError('write_failed', detail);
  if (text.includes('matches no streams') || text.includes('does not contain any stream')) {
    return new ConversionError('no_audio', detail);
  }
  if (
    text.includes('invalid data found') ||
    text.includes('moov atom not found') ||
    text.includes('could not find codec parameters') ||
    text.includes('error while decoding')
  ) {
    return new ConversionError('corrupt', detail);
  }
  return new ConversionError('unknown', detail || 'FFmpeg terminó con error');
}

export interface RunOptions {
  duration: number | null;
  signal: AbortSignal;
  onProgress(fraction: number | null): void;
}

/** Ejecuta un plan y resuelve cuando FFmpeg termina correctamente. */
export function runFfmpeg(ffmpegPath: string, args: string[], options: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new ConversionError('cancelled'));
      return;
    }
    let child;
    try {
      child = spawnFfmpeg(ffmpegPath, args);
    } catch (err) {
      reject(new ConversionError('engine_unavailable', (err as Error).message));
      return;
    }
    lowerPriority(child.pid);

    let stderr = '';
    let pending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        const [key, value] = line.split('=', 2);
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const seconds = Number(value) / 1_000_000;
          if (options.duration && Number.isFinite(seconds) && seconds >= 0) {
            options.onProgress(Math.min(0.995, seconds / options.duration));
          }
        } else if (key === 'progress' && value === 'end') {
          options.onProgress(1);
        }
      }
    });

    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      options.signal.removeEventListener('abort', onAbort);
      reject(new ConversionError('engine_unavailable', err.message));
    });
    child.on('close', (code) => {
      options.signal.removeEventListener('abort', onAbort);
      if (options.signal.aborted) reject(new ConversionError('cancelled'));
      else if (code === 0) resolve();
      else reject(classifyFailure(stderr));
    });
  });
}
