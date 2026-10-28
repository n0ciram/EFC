/**
 * Catálogo de formatos conocidos por EFC.
 *
 * Conocer un formato no implica poder convertirlo: qué conversiones se ofrecen lo decide
 * `registry.ts` según los motores realmente disponibles.
 */
import type { FormatCategory, FormatId, IconId } from '../../src/types/formats';

export interface FormatInfo {
  id: FormatId;
  /** Etiqueta corta que se muestra en la rueda (el nombre descriptivo está en src/i18n). */
  label: string;
  category: FormatCategory;
  /** Extensiones reconocidas; la primera es la que se usa al escribir. */
  extensions: readonly string[];
  icon: IconId;
  /** El formato comprime con pérdidas (afecta a algunas decisiones de calidad). */
  lossy: boolean;
  /** El formato admite transparencia. */
  alpha: boolean;
}

const f = (
  id: FormatId,
  label: string,
  category: FormatCategory,
  extensions: readonly string[],
  icon: IconId,
  lossy: boolean,
  alpha: boolean,
): FormatInfo => ({ id, label, category, extensions, icon, lossy, alpha });

export const FORMATS: Readonly<Record<FormatId, FormatInfo>> = {
  png: f('png', 'PNG', 'image', ['png'], 'photo-alpha', false, true),
  jpg: f('jpg', 'JPG', 'image', ['jpg', 'jpeg', 'jpe', 'jfif'], 'photo', true, false),
  webp: f('webp', 'WEBP', 'image', ['webp'], 'web', true, true),
  avif: f('avif', 'AVIF', 'image', ['avif'], 'sparkle', true, true),
  bmp: f('bmp', 'BMP', 'image', ['bmp', 'dib'], 'grid', false, true),
  tiff: f('tiff', 'TIFF', 'image', ['tif', 'tiff'], 'layers', false, true),
  gif: f('gif', 'GIF', 'image', ['gif'], 'frames', false, true),
  ico: f('ico', 'ICO', 'image', ['ico'], 'app', false, true),
  svg: f('svg', 'SVG', 'image', ['svg'], 'vector', false, true),
  heic: f('heic', 'HEIC', 'image', ['heic', 'heif'], 'photo', true, true),
  pdf: f('pdf', 'PDF', 'document', ['pdf'], 'document', false, false),
  txt: f('txt', 'TXT', 'document', ['txt', 'text', 'log', 'md', 'csv'], 'text', false, false),
  docx: f('docx', 'DOCX', 'document', ['docx'], 'text', false, false),
  doc: f('doc', 'DOC', 'document', ['doc'], 'text', false, false),
  rtf: f('rtf', 'RTF', 'document', ['rtf'], 'text', false, false),
  odt: f('odt', 'ODT', 'document', ['odt'], 'text', false, false),
  xlsx: f('xlsx', 'XLSX', 'document', ['xlsx'], 'grid', false, false),
  xls: f('xls', 'XLS', 'document', ['xls'], 'grid', false, false),
  ods: f('ods', 'ODS', 'document', ['ods'], 'grid', false, false),
  pptx: f('pptx', 'PPTX', 'document', ['pptx', 'ppsx'], 'frames', false, false),
  ppt: f('ppt', 'PPT', 'document', ['ppt', 'pps'], 'frames', false, false),
  odp: f('odp', 'ODP', 'document', ['odp'], 'frames', false, false),
  mp3: f('mp3', 'MP3', 'audio', ['mp3'], 'note', true, false),
  wav: f('wav', 'WAV', 'audio', ['wav'], 'wave', false, false),
  flac: f('flac', 'FLAC', 'audio', ['flac'], 'wave-lossless', false, false),
  ogg: f('ogg', 'OGG', 'audio', ['ogg', 'oga'], 'waves', true, false),
  opus: f('opus', 'OPUS', 'audio', ['opus'], 'waves', true, false),
  m4a: f('m4a', 'M4A', 'audio', ['m4a'], 'note', true, false),
  aac: f('aac', 'AAC', 'audio', ['aac'], 'note', true, false),
  wma: f('wma', 'WMA', 'audio', ['wma'], 'note', true, false),
  aiff: f('aiff', 'AIFF', 'audio', ['aiff', 'aif', 'aifc'], 'wave', false, false),
  amr: f('amr', 'AMR', 'audio', ['amr'], 'note', true, false),
  mp4: f('mp4', 'MP4', 'video', ['mp4', 'm4v'], 'play', true, false),
  mov: f('mov', 'MOV', 'video', ['mov', 'qt'], 'film', true, false),
  webm: f('webm', 'WEBM', 'video', ['webm'], 'web', true, false),
  mkv: f('mkv', 'MKV', 'video', ['mkv'], 'film', true, false),
  avi: f('avi', 'AVI', 'video', ['avi'], 'film', true, false),
  wmv: f('wmv', 'WMV', 'video', ['wmv', 'asf'], 'film', true, false),
  flv: f('flv', 'FLV', 'video', ['flv'], 'film', true, false),
  mpeg: f('mpeg', 'MPEG', 'video', ['mpg', 'mpeg', 'vob'], 'film', true, false),
  ts: f('ts', 'TS', 'video', ['ts', 'mts', 'm2ts'], 'film', true, false),
  '3gp': f('3gp', '3GP', 'video', ['3gp', '3g2'], 'film', true, false),
};

export function formatInfo(id: FormatId): FormatInfo {
  return FORMATS[id];
}

/** Extensión (sin punto) con la que EFC escribe un formato. */
export function outputExtension(id: FormatId): string {
  return FORMATS[id].extensions[0] ?? id;
}

const EXTENSION_INDEX: ReadonlyMap<string, FormatId> = (() => {
  const map = new Map<string, FormatId>();
  for (const info of Object.values(FORMATS)) {
    for (const ext of info.extensions) {
      if (!map.has(ext)) map.set(ext, info.id);
    }
  }
  return map;
})();

/** Formato sugerido por la extensión del nombre (sin validar el contenido). */
export function formatFromExtension(fileName: string): FormatId | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXTENSION_INDEX.get(ext) ?? null;
}
