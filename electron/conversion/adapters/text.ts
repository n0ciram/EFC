/**
 * Texto sin formato (.txt, .log, .md, .csv) a PDF y a documento de Word (.docx).
 *
 * - Codificación: se respeta la marca BOM (UTF-8, UTF-16 LE/BE); sin BOM se usa UTF-8 si el contenido
 *   es UTF-8 válido y, si no, Windows-1252 (la codificación del Bloc de notas antiguo en español).
 * - PDF: A4 con márgenes de 2 cm y la fuente monoespaciada DejaVu Sans Mono incrustada (solo los
 *   caracteres usados), de modo que tildes, ñ, €, griego, cirílico y símbolos se ven igual en
 *   cualquier equipo y las columnas alineadas con espacios se conservan. Las líneas largas se
 *   parten, los tabuladores se expanden y el salto de página (\f) empieza una página nueva.
 * - DOCX: un párrafo por línea, con Consolas, editable en Word. Se genera el paquete ZIP a mano
 *   (sin dependencias) y se vuelve a leer para verificarlo.
 * - Los caracteres que la fuente no puede dibujar (emoji, chino…) se sustituyen por «?» y se
 *   cuentan, para avisar al usuario en lugar de ocultarlo.
 */
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { ConversionError } from '../errors';

export { looksLikeText } from '../text-sniff';

/** Tamaño máximo de un texto que se convierte (evita PDF de decenas de miles de páginas). */
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

export function decodeText(buf: Uint8Array): DecodedText {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: utf8Strict.decode(buf), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
  }
}

export async function readText(filePath: string): Promise<DecodedText> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_TEXT_BYTES) throw new ConversionError('too_large', `${stat.size} bytes de texto`);
  const decoded = decodeText(await fs.readFile(filePath));
  if (decoded.text.replace(/[\s\f]/g, '').length === 0) throw new ConversionError('empty', 'Solo contiene espacios');
  return decoded;
}

/** Líneas lógicas (normaliza CRLF/CR) con los tabuladores expandidos a columnas de 4. */
export function splitLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\t')) return line;
      let out = '';
      for (const ch of line) {
        if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
        else out += ch;
      }
      return out;
    });
}

// ---------------------------------------------------------------------------------------------
// PDF

const PAGE = { width: 595.28, height: 841.89 }; // A4 en puntos
const MARGIN = 56.7; // 2 cm
const FONT_SIZE = 10;
const LINE_HEIGHT = 13;

export interface TextPdfResult {
  data: Uint8Array;
  pages: number;
  /** Caracteres sustituidos por «?» porque la fuente no los tiene. */
  replaced: number;
}

/** Sustituye lo que la fuente no puede dibujar y elimina los caracteres de control. */
function sanitizeForFont(line: string, has: (cp: number) => boolean): { text: string; replaced: number } {
  let out = '';
  let replaced = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || cp === 0xfeff) continue;
    if (has(cp)) out += ch;
    else {
      out += '?';
      replaced++;
    }
  }
  return { text: out, replaced };
}

/** Parte una línea para que quepa en `maxWidth`, preferentemente por espacios. */
function wrap(line: string, font: PDFFont, maxWidth: number): string[] {
  if (line.length === 0 || font.widthOfTextAtSize(line, FONT_SIZE) <= maxWidth) return [line];
  const chars = [...line];
  const parts: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = start;
    let width = 0;
    while (end < chars.length) {
      const w = font.widthOfTextAtSize(chars[end] as string, FONT_SIZE);
      if (width + w > maxWidth && end > start) break;
      width += w;
      end++;
    }
    if (end < chars.length) {
      // Retrocede hasta el último espacio de la línea si lo hay en la mitad derecha.
      let cut = end;
      while (cut > start + (end - start) / 2 && chars[cut - 1] !== ' ') cut--;
      if (cut > start + (end - start) / 2) end = cut;
    }
    parts.push(chars.slice(start, end).join('').replace(/ +$/, ''));
    start = end;
  }
  return parts;
}

export async function textToPdf(
  text: string,
  title: string,
  fontBytes: Uint8Array,
  onPage?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<TextPdfResult> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(title);
  pdf.setCreator('EFC — Easy File Converter');
  pdf.setProducer('EFC — Easy File Converter (pdf-lib)');
  pdf.setCreationDate(new Date());

  const glyphs = fontkit.create(fontBytes);
  const has = (cp: number): boolean => glyphs.hasGlyphForCodePoint(cp);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const maxWidth = PAGE.width - MARGIN * 2;
  const linesPerPage = Math.floor((PAGE.height - MARGIN * 2) / LINE_HEIGHT);

  // Maquetación: páginas de líneas visuales; «\f» fuerza una página nueva.
  const pages: string[][] = [[]];
  let replaced = 0;
  for (const [s, section] of text.split('\f').entries()) {
    if (s > 0 && (pages[pages.length - 1] as string[]).length > 0) pages.push([]);
    for (const raw of splitLines(section)) {
      const clean = sanitizeForFont(raw, has);
      replaced += clean.replaced;
      for (const visual of wrap(clean.text, font, maxWidth)) {
        let page = pages[pages.length - 1] as string[];
        if (page.length >= linesPerPage) {
          page = [];
          pages.push(page);
        }
        page.push(visual);
      }
    }
  }
  // Las líneas vacías del final no generan páginas en blanco.
  while (pages.length > 1 && (pages[pages.length - 1] as string[]).every((l) => l.trim() === '')) pages.pop();

  const ink = rgb(0.08, 0.08, 0.1);
  for (const [i, lines] of pages.entries()) {
    if (signal?.aborted) throw new ConversionError('cancelled');
    const page = pdf.addPage([PAGE.width, PAGE.height]);
    let y = PAGE.height - MARGIN - FONT_SIZE;
    for (const line of lines) {
      if (line.length > 0) page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: ink });
      y -= LINE_HEIGHT;
    }
    onPage?.(i + 1, pages.length);
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  return { data: bytes, pages: pages.length, replaced };
}

// ---------------------------------------------------------------------------------------------
// DOCX

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Elimina lo que XML 1.0 no admite (controles y sustitutos sueltos). */
function xmlSafe(line: string): { text: string; replaced: number } {
  let out = '';
  let replaced = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0) as number;
    const ok = cp === 0x09 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd && cp !== 0xfeff) || cp >= 0x10000;
    if (ok) out += ch;
    else if (cp >= 0x20 && cp !== 0xfeff) {
      out += '?';
      replaced++;
    }
  }
  return { text: out, replaced };
}

function paragraph(line: string): string {
  if (line.length === 0) return '<w:p/>';
  const runs = line
    .split('\t')
    .map((part, i) => `${i > 0 ? '<w:tab/>' : ''}${part ? `<w:t xml:space="preserve">${escapeXml(part)}</w:t>` : ''}`)
    .join('');
  return `<w:p><w:r>${runs}</w:r></w:p>`;
}

export interface TextDocxResult {
  data: Buffer;
  paragraphs: number;
  replaced: number;
}

export function textToDocx(text: string, title: string): TextDocxResult {
  const body: string[] = [];
  let replaced = 0;
  let paragraphs = 0;
  const sections = text.split('\f');
  for (const [s, section] of sections.entries()) {
    const lines = section.replace(/\r\n?/g, '\n').split('\n');
    if (s === sections.length - 1) while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (const [i, raw] of lines.entries()) {
      const clean = xmlSafe(raw);
      replaced += clean.replaced;
      if (s > 0 && i === 0) body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
      body.push(paragraph(clean.text));
      paragraphs++;
    }
  }
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>',
    ],
    [
      '_rels/.rels',
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>',
    ],
    [
      'docProps/core.xml',
      `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>${escapeXml(xmlSafe(title).text)}</dc:title><dc:creator>EFC — Easy File Converter</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`,
    ],
    [
      'word/_rels/document.xml.rels',
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    ],
    [
      'word/styles.xml',
      `${XML_HEADER}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        '</w:styles>',
    ],
    [
      'word/document.xml',
      `${XML_HEADER}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        body.join('') +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
        '</w:body></w:document>',
    ],
  ];
  return { data: zip(files.map(([name, content]) => [name, Buffer.from(content, 'utf8')])), paragraphs, replaced };
}

// ---------------------------------------------------------------------------------------------
// ZIP mínimo (deflate) para el paquete DOCX, y su lectura para verificarlo.

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(entries: [string, Buffer][]): Buffer {
  const { time, date } = dosDateTime(new Date());
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(content, { level: 9 });
    const crc = zlib.crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

/** Lee un ZIP propio (o cualquiera sin ZIP64) y devuelve sus entradas descomprimidas, comprobando el CRC. */
export function unzip(data: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('Sin directorio central');
  const count = data.readUInt16LE(endAt + 10);
  let p = data.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(p) !== 0x02014b50) throw new Error('Directorio central dañado');
    const method = data.readUInt16LE(p + 10);
    const crc = data.readUInt32LE(p + 16);
    const size = data.readUInt32LE(p + 20);
    const nameLength = data.readUInt16LE(p + 28);
    const extra = data.readUInt16LE(p + 30);
    const comment = data.readUInt16LE(p + 32);
    const localAt = data.readUInt32LE(p + 42);
    const name = data.toString('utf8', p + 46, p + 46 + nameLength);
    const localName = data.readUInt16LE(localAt + 26);
    const localExtra = data.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localName + localExtra;
    const raw = data.subarray(start, start + size);
    const content = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (zlib.crc32(content) !== crc) throw new Error(`CRC incorrecto en ${name}`);
    out.set(name, content);
    p += 46 + nameLength + extra + comment;
  }
  return out;
}

/** Verifica el DOCX generado: paquete legible, partes obligatorias y número de párrafos. */
export function verifyDocx(data: Buffer, expectedParagraphs: number): void {
  try {
    const parts = unzip(data);
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
      if (!parts.has(name)) throw new Error(`Falta ${name}`);
    }
    const xml = (parts.get('word/document.xml') as Buffer).toString('utf8');
    const found = (xml.match(/<w:p[ />]/g) ?? []).length - (xml.match(/<w:br w:type="page"\/>/g) ?? []).length;
    if (found !== expectedParagraphs) throw new Error(`Párrafos: ${found} de ${expectedParagraphs}`);
  } catch (err) {
    throw new ConversionError('verify_failed', (err as Error).message);
  }
}
