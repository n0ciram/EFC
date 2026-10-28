/**
 * Detección del tipo real de un archivo a partir de su contenido (firmas o «magic bytes»).
 *
 * La extensión solo se usa para desempatar contenedores ambiguos (ASF → WMA/WMV) o para
 * formatos textuales (SVG). Un archivo con la extensión equivocada se trata según su contenido.
 */
import type { FormatId } from '../../src/types/formats';
import { formatFromExtension } from './formats';
import { looksLikeText } from './text-sniff';

/** Bytes que conviene leer del principio del archivo para detectar su tipo. */
export const DETECT_HEADER_BYTES = 4096;

export interface DetectionResult {
  /** Formato detectado por el contenido, o `null` si no se reconoce. */
  format: FormatId | null;
  /** Formato que sugiere la extensión del nombre. */
  extensionFormat: FormatId | null;
  /** La extensión no coincide con el contenido. */
  mismatch: boolean;
}

const ascii = (buf: Uint8Array, start: number, length: number): string => {
  let out = '';
  const end = Math.min(buf.length, start + length);
  for (let i = start; i < end; i++) out += String.fromCharCode(buf[i] as number);
  return out;
};

const startsWith = (buf: Uint8Array, bytes: readonly number[], offset = 0): boolean => {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
};

const u32le = (buf: Uint8Array, offset: number): number =>
  ((buf[offset] as number) |
    ((buf[offset + 1] as number) << 8) |
    ((buf[offset + 2] as number) << 16) |
    ((buf[offset + 3] as number) << 24)) >>>
  0;

const u32be = (buf: Uint8Array, offset: number): number =>
  (((buf[offset] as number) << 24) |
    ((buf[offset + 1] as number) << 16) |
    ((buf[offset + 2] as number) << 8) |
    (buf[offset + 3] as number)) >>>
  0;

const u16le = (buf: Uint8Array, offset: number): number => (buf[offset] as number) | ((buf[offset + 1] as number) << 8);

/** Contenedor OLE/CFB: documentos de Office 97-2003 y documentos modernos cifrados con contraseña. */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
/** Formatos de Office que son un ZIP. Con contraseña, Office los guarda cifrados dentro de un CFB. */
const OOXML_FORMATS: readonly FormatId[] = ['docx', 'xlsx', 'pptx'];
const CFB_FORMATS: readonly FormatId[] = ['doc', 'xls', 'ppt'];

/** Nombres de las primeras entradas de un ZIP (las que caben en la cabecera leída). */
function zipEntryNames(buf: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= buf.length && startsWith(buf, ZIP_SIGNATURE, offset)) {
    const flags = u16le(buf, offset + 6);
    const size = u32le(buf, offset + 18);
    const nameLength = u16le(buf, offset + 26);
    const extraLength = u16le(buf, offset + 28);
    names.push(ascii(buf, offset + 30, nameLength));
    if (flags & 0x08) break; // tamaño al final de los datos: no se puede saltar a la siguiente entrada
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

function detectZip(buf: Uint8Array, extensionFormat: FormatId | null): FormatId | null {
  const names = zipEntryNames(buf);
  // OpenDocument: la primera entrada es «mimetype», sin comprimir, con el tipo del documento.
  if (names[0] === 'mimetype') {
    const mime = ascii(buf, 38, 64);
    if (mime.startsWith('application/vnd.oasis.opendocument.text')) return 'odt';
    if (mime.startsWith('application/vnd.oasis.opendocument.spreadsheet')) return 'ods';
    if (mime.startsWith('application/vnd.oasis.opendocument.presentation')) return 'odp';
    return null;
  }
  // Office moderno: la carpeta interna delata la aplicación. Si no aparece en la cabecera, se
  // acepta la extensión (Office comprobará el contenido al abrirlo).
  if (names.some((n) => n.startsWith('word/'))) return 'docx';
  if (names.some((n) => n.startsWith('xl/'))) return 'xlsx';
  if (names.some((n) => n.startsWith('ppt/'))) return 'pptx';
  return extensionFormat && OOXML_FORMATS.includes(extensionFormat) ? extensionFormat : null;
}

/** Documento de Office moderno (DOCX, XLSX, PPTX) cifrado con contraseña de apertura. */
export function isEncryptedOoxml(header: Uint8Array, format: FormatId): boolean {
  return OOXML_FORMATS.includes(format) && startsWith(header, CFB_SIGNATURE);
}

const ASF_GUID = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];

function detectIsoBmff(buf: Uint8Array): FormatId | null {
  if (buf.length < 12) return null;
  const boxType = ascii(buf, 4, 4);
  if (boxType !== 'ftyp') {
    // QuickTime antiguo sin caja ftyp.
    if (['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'].includes(boxType)) return 'mov';
    return null;
  }
  const major = ascii(buf, 8, 4);
  const boxSize = Math.min(u32be(buf, 0), buf.length);
  const brands = new Set<string>([major]);
  for (let off = 16; off + 4 <= boxSize; off += 4) brands.add(ascii(buf, off, 4));

  if (brands.has('avif') || brands.has('avis')) return 'avif';
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(major)) return 'heic';
  if (major === 'qt  ') return 'mov';
  if (['M4A ', 'M4B ', 'M4P '].includes(major)) return 'm4a';
  if (major.startsWith('3gp') || major.startsWith('3g2') || major.startsWith('3gs')) return '3gp';
  if (major.startsWith('crx')) return null; // RAW de Canon
  return 'mp4';
}

function detectEbml(buf: Uint8Array): FormatId | null {
  const head = ascii(buf, 0, Math.min(buf.length, 96)).toLowerCase();
  if (head.includes('webm')) return 'webm';
  if (head.includes('matroska')) return 'mkv';
  return 'mkv';
}

function detectOgg(buf: Uint8Array): FormatId | null {
  const head = ascii(buf, 0, Math.min(buf.length, 128));
  if (head.includes('OpusHead')) return 'opus';
  if (head.includes('\x01vorbis') || head.includes('\x7fFLAC') || head.includes('Speex')) return 'ogg';
  if (head.includes('\x80theora')) return null; // vídeo Ogg/Theora: no soportado
  return 'ogg';
}

function syncsafe(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] as number) & 0x7f) << 21) |
    (((buf[offset + 1] as number) & 0x7f) << 14) |
    (((buf[offset + 2] as number) & 0x7f) << 7) |
    ((buf[offset + 3] as number) & 0x7f)
  );
}

function detectMpegAudioFrame(buf: Uint8Array, offset: number): FormatId | null {
  if (buf.length < offset + 2) return null;
  const b0 = buf[offset] as number;
  const b1 = buf[offset + 1] as number;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const layer = (b1 >> 1) & 0x03;
  if ((b1 & 0xf6) === 0xf0) return 'aac'; // ADTS: capa 00
  if (layer === 0x01 || layer === 0x02 || layer === 0x03) return 'mp3';
  return null;
}

function looksLikeSvg(buf: Uint8Array): boolean {
  let text = ascii(buf, 0, Math.min(buf.length, DETECT_HEADER_BYTES));
  if (text.startsWith('\xef\xbb\xbf')) text = text.slice(3);
  const trimmed = text.trimStart().toLowerCase();
  if (!(trimmed.startsWith('<?xml') || trimmed.startsWith('<svg') || trimmed.startsWith('<!--') || trimmed.startsWith('<!doctype svg'))) {
    return false;
  }
  return trimmed.includes('<svg');
}

/** Detecta el formato por contenido. `fileName` solo se usa para desempates. */
export function detectFormat(header: Uint8Array, fileName: string): DetectionResult {
  const extensionFormat = formatFromExtension(fileName);
  const format = sniff(header, extensionFormat);
  return {
    format,
    extensionFormat,
    mismatch: format !== null && extensionFormat !== null && format !== extensionFormat && !equivalent(format, extensionFormat),
  };
}

/** Formatos que comparten contenedor y se consideran equivalentes a efectos de aviso. */
function equivalent(a: FormatId, b: FormatId): boolean {
  const groups: FormatId[][] = [
    ['mp4', 'm4a', 'mov', '3gp'],
    ['mkv', 'webm'],
    ['ogg', 'opus'],
    ['wma', 'wmv'],
    ['mp3', 'aac'],
    ['heic', 'avif'],
    // Word, Excel y PowerPoint abren cualquiera de los formatos de su familia.
    ['docx', 'doc', 'rtf', 'odt'],
    ['xlsx', 'xls', 'ods'],
    ['pptx', 'ppt', 'odp'],
  ];
  return groups.some((g) => g.includes(a) && g.includes(b));
}

function sniff(buf: Uint8Array, extensionFormat: FormatId | null): FormatId | null {
  if (buf.length < 4) return null;

  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  const sig6 = ascii(buf, 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'gif';

  const sig4 = ascii(buf, 0, 4);
  if (sig4 === 'RIFF' && buf.length >= 12) {
    const kind = ascii(buf, 8, 4);
    if (kind === 'WEBP') return 'webp';
    if (kind === 'WAVE') return 'wav';
    if (kind === 'AVI ') return 'avi';
    return null;
  }
  if (sig4 === 'RF64' && ascii(buf, 8, 4) === 'WAVE') return 'wav';

  if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 18) {
    const dibSize = u32le(buf, 14);
    if ([12, 16, 40, 52, 56, 64, 108, 124].includes(dibSize)) return 'bmp';
  }

  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  if (startsWith(buf, [0x49, 0x49, 0x2b, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2b])) return 'tiff';

  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length >= 22) {
    const count = (buf[4] as number) | ((buf[5] as number) << 8);
    if (count > 0 && count < 256 && buf[9] === 0) return 'ico';
  }

  const head1k = ascii(buf, 0, Math.min(buf.length, 1024));
  if (head1k.includes('%PDF-')) return 'pdf';

  if (startsWith(buf, ZIP_SIGNATURE)) return detectZip(buf, extensionFormat);
  if (startsWith(buf, CFB_SIGNATURE)) {
    // El CFB no indica la aplicación en su cabecera: se usa la extensión (también es el contenedor de
    // .msg, .msi…, que no se aceptan). Un DOCX/XLSX/PPTX dentro de un CFB está cifrado.
    if (extensionFormat && (CFB_FORMATS.includes(extensionFormat) || OOXML_FORMATS.includes(extensionFormat))) return extensionFormat;
    return null;
  }
  if (ascii(buf, 0, 5) === '{\\rtf') return 'rtf';

  const iso = detectIsoBmff(buf);
  if (iso) return iso;

  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return detectEbml(buf);
  if (sig4 === 'fLaC') return 'flac';
  if (sig4 === 'OggS') return detectOgg(buf);
  if (sig4 === 'FORM' && buf.length >= 12) {
    const kind = ascii(buf, 8, 4);
    if (kind === 'AIFF' || kind === 'AIFC') return 'aiff';
  }
  if (ascii(buf, 0, 5) === '#!AMR') return 'amr';
  if (startsWith(buf, ASF_GUID)) return extensionFormat === 'wma' ? 'wma' : 'wmv';
  if (ascii(buf, 0, 3) === 'FLV' && buf[3] === 0x01) return 'flv';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0xba]) || startsWith(buf, [0x00, 0x00, 0x01, 0xb3])) return 'mpeg';
  if (buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) return 'ts';
  if (buf.length > 392 && buf[4] === 0x47 && buf[196] === 0x47 && buf[388] === 0x47) return 'ts';

  if (ascii(buf, 0, 3) === 'ID3' && buf.length >= 10) {
    const tagSize = 10 + syncsafe(buf, 6);
    const frame = detectMpegAudioFrame(buf, tagSize);
    if (frame) return frame;
    return extensionFormat === 'aac' ? 'aac' : 'mp3';
  }
  // Una sincronía MPEG sin etiqueta ID3 es poco específica: solo se acepta si la extensión acompaña.
  const frame = detectMpegAudioFrame(buf, 0);
  if (frame && (extensionFormat === 'mp3' || extensionFormat === 'aac')) return frame;

  if (looksLikeSvg(buf)) return 'svg';

  // El texto no tiene firma: solo se acepta con una extensión de texto y contenido que lo parezca.
  if (extensionFormat === 'txt' && looksLikeText(buf)) return 'txt';

  return null;
}
