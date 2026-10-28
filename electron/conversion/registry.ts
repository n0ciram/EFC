/**
 * Registro modular de conversiones.
 *
 * Cada regla declara qué formatos de origen acepta, qué destinos produce, qué motor la
 * ejecuta y qué necesita para estar disponible. Para añadir un formato nuevo basta con
 * añadirlo al catálogo (`formats.ts`), declarar aquí la regla y aportar un adaptador.
 */
import type { FormatId, IconId, TargetId } from '../../src/types/formats';
import type { TargetGroup } from '../../src/types/ipc';
import { DEFAULT_LANGUAGE, messages, type Language, type Messages } from '../../src/i18n';
import { FORMATS } from './formats';

export type EngineKind =
  | 'image'
  | 'image-pdf'
  | 'image-shrink'
  | 'pdf-raster'
  | 'pdf-text'
  | 'pdf-split'
  | 'pdf-rotate'
  | 'pdf-shrink'
  | 'text-pdf'
  | 'text-docx'
  | 'ffmpeg-audio'
  | 'ffmpeg-video'
  | 'video-shrink'
  | 'office-pdf';

export type OfficeApp = 'word' | 'excel' | 'powerpoint';

/** Aplicaciones de Office instaladas (las que se pueden automatizar). */
export type OfficeApps = Readonly<Record<OfficeApp, boolean>>;

export const OFFICE_APP_NAMES: Readonly<Record<OfficeApp, string>> = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint' };

/** Documentos que se convierten a PDF con Office, y la aplicación que abre cada uno. */
const OFFICE_SOURCES: Partial<Record<FormatId, OfficeApp>> = {
  docx: 'word',
  doc: 'word',
  rtf: 'word',
  odt: 'word',
  xlsx: 'excel',
  xls: 'excel',
  ods: 'excel',
  pptx: 'powerpoint',
  ppt: 'powerpoint',
  odp: 'powerpoint',
};

/** Aplicación de Office que abre un formato, o `null` si no es un documento de Office. */
export function officeAppFor(format: FormatId): OfficeApp | null {
  return OFFICE_SOURCES[format] ?? null;
}

export interface FfmpegCaps {
  path: string;
  version: string;
  encoders: ReadonlySet<string>;
  /** Origen del ejecutable: incluido con EFC, configurado por el usuario o encontrado en el PATH. */
  source: 'bundled' | 'config' | 'path';
}

export interface EngineCaps {
  /** sharp cargado correctamente. */
  image: boolean;
  /** pdf.js y su lienzo cargados correctamente. */
  pdf: boolean;
  /** FFmpeg encontrado y analizado, o `null` si no está disponible. */
  ffmpeg: FfmpegCaps | null;
  /** Fuente incluida para escribir texto en PDF (si falta, no se ofrece TXT → PDF). */
  text?: boolean;
  /** Aplicaciones de Office instaladas; sin Office no se ofrecen sus documentos. */
  office?: OfficeApps | null;
}

export interface SourceDescriptor {
  format: FormatId;
}

export interface TargetOption {
  id: TargetId;
  /** Formato del archivo resultante. */
  format: FormatId;
  label: string;
  description: string;
  icon: IconId;
  engine: EngineKind;
  /** Pétalo agrupado (ver `WheelTarget.group`). */
  group?: TargetGroup;
}

/** Destinos que son herramientas (acciones) y no formatos. */
const TOOL_TARGETS: ReadonlySet<TargetId> = new Set<TargetId>(['pdf-merge', 'shrink', 'pdf-split', 'pdf-rotate']);

/** Imágenes de mapa de bits que sharp (o el códec BMP propio) puede leer. */
export const RASTER_SOURCES: readonly FormatId[] = ['png', 'jpg', 'webp', 'avif', 'bmp', 'tiff', 'gif'];
export const IMAGE_SOURCES: readonly FormatId[] = [...RASTER_SOURCES, 'svg'];
export const IMAGE_TARGETS: readonly FormatId[] = ['jpg', 'png', 'webp', 'avif', 'bmp', 'tiff', 'gif', 'ico'];
export const PDF_RASTER_TARGETS: readonly FormatId[] = ['jpg', 'png', 'webp', 'tiff'];
export const AUDIO_SOURCES: readonly FormatId[] = ['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'amr'];
export const VIDEO_SOURCES: readonly FormatId[] = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpeg', 'ts', '3gp'];
export const AUDIO_TARGETS: readonly FormatId[] = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'];
/** Del vídeo solo se ofrece extraer el audio a los formatos más habituales. */
export const AUDIO_FROM_VIDEO_TARGETS: readonly FormatId[] = ['mp3', 'm4a', 'wav'];
export const VIDEO_TARGETS: readonly FormatId[] = ['mp4', 'mov', 'webm', 'mkv', 'gif'];

/** Orden de relevancia por formato de origen (el primero ocupa la posición destacada). */
const RANKING: Partial<Record<FormatId, readonly TargetId[]>> = {
  png: ['jpg', 'webp', 'pdf', 'shrink', 'ico', 'avif', 'tiff', 'bmp', 'gif'],
  jpg: ['png', 'shrink', 'webp', 'pdf', 'avif', 'tiff', 'bmp', 'gif', 'ico'],
  webp: ['png', 'jpg', 'shrink', 'gif', 'pdf', 'avif', 'tiff', 'bmp', 'ico'],
  avif: ['png', 'jpg', 'webp', 'shrink', 'pdf', 'tiff', 'bmp', 'gif', 'ico'],
  bmp: ['png', 'jpg', 'shrink', 'webp', 'pdf', 'tiff', 'ico', 'avif', 'gif'],
  tiff: ['jpg', 'png', 'pdf', 'shrink', 'webp', 'avif', 'bmp', 'gif', 'ico'],
  gif: ['png', 'mp4', 'shrink', 'webp', 'jpg', 'webm', 'pdf', 'avif', 'tiff', 'bmp', 'ico'],
  svg: ['png', 'jpg', 'webp', 'ico', 'avif', 'tiff', 'bmp', 'gif'],
  pdf: ['jpg', 'shrink', 'pdf-split', 'pdf-rotate', 'png', 'txt', 'webp', 'tiff'],
  txt: ['pdf', 'docx'],
  ...(Object.fromEntries(Object.keys(OFFICE_SOURCES).map((id) => [id, ['pdf']])) as Partial<Record<FormatId, readonly TargetId[]>>),
};
const AUDIO_RANKING: readonly TargetId[] = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'];
// Para un MP4 el primer destino posible es «Reducir» (convertir a MP4 no tendría sentido).
const VIDEO_RANKING: readonly TargetId[] = ['mp4', 'shrink', 'mp3', 'gif', 'webm', 'mov', 'mkv', 'm4a', 'wav'];

/** Codificadores aceptables para cada necesidad, por orden de preferencia. */
export const ENCODER_CHOICES = {
  h264: ['libx264', 'h264_mf', 'libopenh264'],
  aac: ['aac', 'libfdk_aac', 'aac_mf'],
  mp3: ['libmp3lame', 'mp3_mf', 'libshine'],
  vorbis: ['libvorbis'],
  opus: ['libopus'],
  flac: ['flac'],
  pcm: ['pcm_s16le'],
  vp9: ['libvpx-vp9', 'libvpx'],
  gif: ['gif'],
} as const;

export type EncoderNeed = keyof typeof ENCODER_CHOICES;

export function pickEncoder(caps: FfmpegCaps, need: EncoderNeed): string | null {
  for (const name of ENCODER_CHOICES[need]) {
    if (caps.encoders.has(name)) return name;
  }
  return null;
}

/** Codificadores imprescindibles para producir cada formato con FFmpeg. */
const FFMPEG_NEEDS: Partial<Record<FormatId, readonly EncoderNeed[]>> = {
  mp3: ['mp3'],
  wav: ['pcm'],
  flac: ['flac'],
  m4a: ['aac'],
  ogg: ['vorbis'],
  opus: ['opus'],
  mp4: ['h264', 'aac'],
  mov: ['h264', 'aac'],
  mkv: ['h264', 'aac'],
  webm: ['vp9'],
  gif: ['gif'],
};

function ffmpegCanProduce(caps: FfmpegCaps | null, format: FormatId): boolean {
  if (!caps) return false;
  const needs = FFMPEG_NEEDS[format];
  if (!needs) return false;
  return needs.every((need) => pickEncoder(caps, need) !== null);
}

/** Motor que convierte un formato de origen a un destino, o `null` si no hay ninguno. */
export function engineFor(source: FormatId, target: TargetId, caps: EngineCaps): EngineKind | null {
  if (target === 'pdf-merge') {
    if (source === 'pdf') return 'image-pdf'; // las páginas se copian tal cual con pdf-lib
    return caps.image && RASTER_SOURCES.includes(source) ? 'image-pdf' : null;
  }
  if (target === 'pdf-split' || target === 'pdf-rotate') return source === 'pdf' ? target : null;
  if (target === 'shrink') {
    if (source === 'pdf') return caps.image ? 'pdf-shrink' : null;
    if (RASTER_SOURCES.includes(source)) return caps.image ? 'image-shrink' : null;
    if (VIDEO_SOURCES.includes(source)) return caps.ffmpeg && pickEncoder(caps.ffmpeg, 'h264') && pickEncoder(caps.ffmpeg, 'aac') ? 'video-shrink' : null;
    return null;
  }
  if (IMAGE_SOURCES.includes(source)) {
    if (target === 'pdf') return caps.image && RASTER_SOURCES.includes(source) ? 'image-pdf' : null;
    if (IMAGE_TARGETS.includes(target)) return caps.image ? 'image' : null;
    if (source === 'gif' && (target === 'mp4' || target === 'webm') && ffmpegCanProduce(caps.ffmpeg, target)) {
      return 'ffmpeg-video';
    }
    return null;
  }
  if (source === 'pdf') {
    if (target === 'txt') return caps.pdf ? 'pdf-text' : null;
    if (PDF_RASTER_TARGETS.includes(target)) return caps.pdf && caps.image ? 'pdf-raster' : null;
    return null;
  }
  if (source === 'txt') {
    if (target === 'pdf') return caps.text !== false ? 'text-pdf' : null;
    if (target === 'docx') return 'text-docx';
    return null;
  }
  const officeApp = officeAppFor(source);
  if (officeApp) return target === 'pdf' && caps.office?.[officeApp] ? 'office-pdf' : null;
  if (AUDIO_SOURCES.includes(source)) {
    return AUDIO_TARGETS.includes(target) && ffmpegCanProduce(caps.ffmpeg, target) ? 'ffmpeg-audio' : null;
  }
  if (VIDEO_SOURCES.includes(source)) {
    if (VIDEO_TARGETS.includes(target) && ffmpegCanProduce(caps.ffmpeg, target)) return 'ffmpeg-video';
    if (AUDIO_FROM_VIDEO_TARGETS.includes(target) && ffmpegCanProduce(caps.ffmpeg, target)) return 'ffmpeg-audio';
    return null;
  }
  return null;
}

function rankingFor(source: FormatId): readonly TargetId[] {
  const specific = RANKING[source];
  if (specific) return specific;
  if (AUDIO_SOURCES.includes(source)) return AUDIO_RANKING;
  if (VIDEO_SOURCES.includes(source)) return VIDEO_RANKING;
  return [];
}

function describe(target: TargetId, source: FormatId, m: Messages): Pick<TargetOption, 'label' | 'description' | 'icon' | 'format'> {
  const t = m.targets;
  if (target === 'pdf-merge') {
    return { format: 'pdf', label: t.merge, description: t.mergeDescription, icon: 'merge' };
  }
  if (target === 'pdf-split') return { format: 'pdf', label: t.split, description: t.splitDescription, icon: 'split' };
  if (target === 'pdf-rotate') return { format: 'pdf', label: t.rotate, description: t.rotateDescription, icon: 'rotate' };
  if (target === 'shrink') {
    const video = VIDEO_SOURCES.includes(source);
    const description = video ? t.shrinkVideo : source === 'pdf' ? t.shrinkPdf : t.shrinkImage;
    return { format: source, label: t.shrink, description, icon: 'shrink' };
  }
  const info = FORMATS[target];
  const fromVideo = VIDEO_SOURCES.includes(source) || source === 'gif';
  if (fromVideo && info.category === 'audio') {
    return { format: target, label: info.label, description: t.extractAudio(info.label), icon: info.icon };
  }
  if (source === 'pdf' && info.category === 'image') {
    return { format: target, label: info.label, description: t.pdfPages(info.label), icon: info.icon };
  }
  if (source === 'pdf' && target === 'txt') {
    return { format: target, label: info.label, description: t.extractText, icon: info.icon };
  }
  return { format: target, label: info.label, description: m.formats[target], icon: info.icon };
}

/**
 * Destinos que se pueden ofrecer para una selección.
 *
 * - Con varios archivos se ofrecen los destinos válidos para todos ellos; un archivo que ya
 *   está en el formato de destino simplemente se omite al convertir.
 * - Con dos o más imágenes se añade «Unir en PDF».
 */
export function availableTargets(sources: readonly SourceDescriptor[], caps: EngineCaps, language: Language = DEFAULT_LANGUAGE): TargetOption[] {
  if (sources.length === 0) return [];
  const m = messages(language);
  const first = sources[0] as SourceDescriptor;

  const candidates: TargetId[] = [];
  const seen = new Set<TargetId>();
  for (const src of sources) {
    for (const t of rankingFor(src.format)) {
      if (!seen.has(t)) {
        seen.add(t);
        candidates.push(t);
      }
    }
  }
  // El orden lo marca el primer archivo; el resto de candidatos va detrás.
  const firstRanking = rankingFor(first.format);
  candidates.sort((a, b) => {
    const ia = firstRanking.indexOf(a);
    const ib = firstRanking.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });

  const result: TargetOption[] = [];
  for (const target of candidates) {
    let needsWork = false;
    let ok = true;
    let engine: EngineKind | null = null;
    for (const src of sources) {
      if (src.format === target) continue; // ya está en ese formato: se omitirá
      const e = engineFor(src.format, target, caps);
      if (!e) {
        ok = false;
        break;
      }
      needsWork = true;
      engine ??= e;
    }
    if (ok && needsWork && engine) {
      result.push({ id: target, engine, ...describe(target, first.format, m) });
    }
  }

  if (sources.length >= 2 && sources.every((s) => engineFor(s.format, 'pdf-merge', caps) !== null)) {
    const pdfIndex = result.findIndex((t) => t.id === 'pdf');
    const withPdf = sources.some((s) => s.format === 'pdf');
    const merge: TargetOption = { id: 'pdf-merge', engine: 'image-pdf', ...describe('pdf-merge', first.format, m) };
    // Con PDF seleccionados, unirlos es lo más probable: va el primero.
    const at = withPdf ? 0 : pdfIndex >= 0 ? pdfIndex + 1 : result.length;
    result.splice(at, 0, merge);
  }
  // La rueda principal queda para los formatos: las herramientas (unir, reducir, separar, girar) van
  // juntas en su propio pétalo. «Herramientas PDF» si hay algún PDF, «Herramientas» con solo imágenes.
  // En vídeo, REDUCIR sigue en la rueda principal (es la única herramienta).
  const anyPdf = sources.some((s) => s.format === 'pdf');
  const allImages = sources.every((s) => IMAGE_SOURCES.includes(s.format));
  const group: TargetOption['group'] = anyPdf ? 'pdf-tools' : allImages ? 'image-tools' : undefined;
  if (group) for (const t of result) if (TOOL_TARGETS.has(t.id)) t.group = group;
  return result;
}

/** Explica por qué no hay destinos, para el aviso discreto. */
export function explainNoTargets(sources: readonly SourceDescriptor[], caps: EngineCaps, language: Language = DEFAULT_LANGUAGE): string {
  const t = messages(language).noTargets;
  const formats = [...new Set(sources.map((s) => s.format))];
  const labels = formats.map((id) => FORMATS[id].label).join(', ');
  const needsFfmpeg = formats.some((id) => AUDIO_SOURCES.includes(id) || VIDEO_SOURCES.includes(id));
  if (needsFfmpeg && !caps.ffmpeg) return t.noFfmpeg(labels);
  const missingOffice = [...new Set(formats.map(officeAppFor))].filter((app): app is OfficeApp => app !== null && !caps.office?.[app]);
  if (missingOffice.length > 0) {
    const apps = missingOffice.map((app) => `Microsoft ${OFFICE_APP_NAMES[app]}`).join(t.and);
    return t.needsOffice(labels, apps, missingOffice.length > 1);
  }
  if (formats.includes('heic')) return t.heic;
  if (formats.length > 1) return t.noCommon(labels);
  return t.none(labels);
}
