/**
 * Audio y vídeo con FFmpeg y archivos reales generados al vuelo.
 * Si no hay FFmpeg disponible las pruebas se marcan como omitidas (no como superadas).
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { probeMedia } from '../../electron/conversion/adapters/ffmpeg';
import { runJob } from '../../electron/conversion/engine';
import type { FfmpegCaps } from '../../electron/conversion/registry';
import type { FormatId, TargetId } from '../../src/types/formats';
import { ffmpegCaps, makeMedia, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

describe('Audio y vídeo con FFmpeg (archivos reales)', async () => {
  const caps = await ffmpegCaps();
  const skip = caps ? false : 'FFmpeg no está disponible en este equipo';
  let dir = '';
  let wav = '';
  let mp4 = '';

  const convert = async (target: TargetId, file: string, format: FormatId, onFraction?: (f: number | null) => void) =>
    runJob(spec(target, [{ path: file, format }], caps as FfmpegCaps), (u) => onFraction?.(u.fraction), new AbortController().signal);

  before(async () => {
    if (!caps) return;
    dir = await makeTempDir('multimedia');
    wav = path.join(dir, 'tono de prueba.wav');
    mp4 = path.join(dir, 'vídeo de prueba.mp4');
    makeMedia(caps.path, wav, 'tone', ['-c:a', 'pcm_s16le']);
    makeMedia(caps.path, mp4, 'video', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  });
  after(async () => {
    if (dir) await removeDir(dir);
  });

  for (const [target, codec] of [
    ['mp3', 'mp3'],
    ['flac', 'flac'],
    ['m4a', 'aac'],
    ['ogg', 'vorbis'],
    ['opus', 'opus'],
  ] as const) {
    it(`WAV → ${target.toUpperCase()} produce audio ${codec} de la misma duración`, { skip }, async () => {
      const before = await sha256(wav);
      const fractions: number[] = [];
      const result = await convert(target, wav, 'wav', (f) => f !== null && fractions.push(f));
      assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
      const out = result.outputs[0]?.output as string;
      assert.equal(path.extname(out), `.${target}`);
      const info = await probeMedia((caps as FfmpegCaps).path, out);
      assert.equal(info.audio?.codec, codec);
      assert.ok(info.duration !== null && Math.abs(info.duration - 2) < 0.15, `duración ${info.duration}`);
      assert.equal(fractions.at(-1), 1, 'el progreso real llega al 100 %');
      for (let i = 1; i < fractions.length; i++) assert.ok((fractions[i] as number) >= (fractions[i - 1] as number), 'el progreso no retrocede');
      assert.equal(await sha256(wav), before);
    });
  }

  it('MP4 → MP3 extrae el audio del vídeo', { skip }, async () => {
    const result = await convert('mp3', mp4, 'mp4');
    const info = await probeMedia((caps as FfmpegCaps).path, result.outputs[0]?.output as string);
    assert.equal(info.audio?.codec, 'mp3');
    assert.equal(info.video, null);
  });

  it('MP4 (H.264/AAC) → MOV copia los flujos sin recodificar', { skip }, async () => {
    const result = await convert('mov', mp4, 'mp4');
    const info = await probeMedia((caps as FfmpegCaps).path, result.outputs[0]?.output as string);
    assert.equal(info.video?.codec, 'h264');
    assert.equal(info.audio?.codec, 'aac');
  });

  it('MP4 → WEBM recodifica a VP9/Opus', { skip }, async () => {
    const result = await convert('webm', mp4, 'mp4');
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const info = await probeMedia((caps as FfmpegCaps).path, result.outputs[0]?.output as string);
    assert.ok(['vp9', 'vp8'].includes(info.video?.codec as string));
    assert.ok(['opus', 'vorbis'].includes(info.audio?.codec as string));
  });

  it('MP4 → GIF genera una animación', { skip }, async () => {
    const result = await convert('gif', mp4, 'mp4');
    const info = await probeMedia((caps as FfmpegCaps).path, result.outputs[0]?.output as string);
    assert.equal(info.video?.codec, 'gif');
  });

  it('WAV → MP4 no se ofrece; un audio sin vídeo pedido como vídeo falla de forma controlada', { skip }, async () => {
    const result = await runJob(spec('mp4', [{ path: wav, format: 'wav' }], caps as FfmpegCaps), () => undefined, new AbortController().signal);
    assert.equal(result.outputs.length, 0);
    assert.equal(result.failures[0]?.code, 'unsupported');
  });

  it('cancelar una conversión detiene FFmpeg y no deja archivos', { skip }, async () => {
    const long = path.join(dir, 'largo.wav');
    makeMedia((caps as FfmpegCaps).path, long, 'tone', ['-c:a', 'pcm_s16le', '-t', '2']);
    // Concatenamos el tono muchas veces para que la codificación dure lo suficiente.
    const longer = path.join(dir, 'muy largo.wav');
    const { spawnSync } = await import('node:child_process');
    spawnSync((caps as FfmpegCaps).path, ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '200', '-i', long, '-c:a', 'pcm_s16le', longer]);
    const controller = new AbortController();
    const started = runJob(spec('flac', [{ path: longer, format: 'wav' }], caps as FfmpegCaps), () => undefined, controller.signal);
    setTimeout(() => controller.abort(), 150);
    const result = await started;
    assert.equal(result.cancelled, true);
    const leftovers = (await fs.readdir(dir)).filter((n) => n.startsWith('.~efc-') || n === 'muy largo.flac');
    assert.deepEqual(leftovers, []);
  });

  it('un archivo multimedia dañado produce un error controlado', { skip }, async () => {
    const broken = path.join(dir, 'roto.mp4');
    await fs.writeFile(broken, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2000, 7)]));
    const result = await convert('mp3', broken, 'mp4');
    assert.equal(result.outputs.length, 0);
    assert.ok(['corrupt', 'no_audio', 'unknown'].includes(result.failures[0]?.code as string), result.failures[0]?.code);
    assert.ok(!(await fs.readdir(dir)).includes('roto.mp3'));
  });
});
