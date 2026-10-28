import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFormat, isEncryptedOoxml } from '../../electron/conversion/detect';

const bytes = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  while (out.length < 64) out.push(0);
  return new Uint8Array(out);
};

const ftyp = (brand: string, compat: string[] = []): Uint8Array => {
  const size = 16 + compat.length * 4;
  return bytes([0, 0, 0, size], 'ftyp', brand, [0, 0, 0, 0], compat.join(''));
};

describe('Detección por contenido', () => {
  const cases: [string, Uint8Array, string, string | null][] = [
    ['PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a.png', 'png'],
    ['JPEG', bytes([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg', 'jpg'],
    ['GIF', bytes('GIF89a'), 'a.gif', 'gif'],
    ['WebP', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '), 'a.webp', 'webp'],
    ['WAV', bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '), 'a.wav', 'wav'],
    ['AVI', bytes('RIFF', [0, 0, 0, 0], 'AVI LIST'), 'a.avi', 'avi'],
    ['BMP', bytes('BM', [0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0]), 'a.bmp', 'bmp'],
    ['TIFF LE', bytes([0x49, 0x49, 0x2a, 0x00]), 'a.tif', 'tiff'],
    ['TIFF BE', bytes([0x4d, 0x4d, 0x00, 0x2a]), 'a.tiff', 'tiff'],
    ['PDF', bytes('%PDF-1.7'), 'a.pdf', 'pdf'],
    ['AVIF', ftyp('avif', ['mif1', 'miaf']), 'a.avif', 'avif'],
    ['HEIC', ftyp('heic', ['mif1']), 'a.heic', 'heic'],
    ['MP4', ftyp('isom', ['iso2', 'avc1', 'mp41']), 'a.mp4', 'mp4'],
    ['MOV', ftyp('qt  '), 'a.mov', 'mov'],
    ['M4A', ftyp('M4A ', ['isom']), 'a.m4a', 'm4a'],
    ['3GP', ftyp('3gp4'), 'a.3gp', '3gp'],
    ['MKV', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01], 'B\x82\x88matroska'), 'a.mkv', 'mkv'],
    ['WebM', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01], 'B\x82\x84webm'), 'a.webm', 'webm'],
    ['FLAC', bytes('fLaC'), 'a.flac', 'flac'],
    ['Ogg Vorbis', bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0, 1, 1, 30], '\x01vorbis'), 'a.ogg', 'ogg'],
    ['Opus', bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0, 1, 1, 19], 'OpusHead'), 'a.opus', 'opus'],
    ['MP3 con ID3', bytes('ID3', [3, 0, 0, 0, 0, 0, 0], [0xff, 0xfb, 0x90, 0x64]), 'a.mp3', 'mp3'],
    ['MP3 sin ID3', bytes([0xff, 0xfb, 0x90, 0x64]), 'a.mp3', 'mp3'],
    ['FLV', bytes('FLV', [1, 5]), 'a.flv', 'flv'],
    ['AIFF', bytes('FORM', [0, 0, 0, 0], 'AIFF'), 'a.aiff', 'aiff'],
    ['SVG', bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'a.svg', 'svg'],
    ['Desconocido', bytes('hola, esto es texto'), 'a.txt', null],
  ];

  for (const [name, header, file, expected] of cases) {
    it(name, () => {
      assert.equal(detectFormat(header, file).format, expected);
    });
  }

  it('usa el contenido aunque la extensión mienta y lo señala', () => {
    const result = detectFormat(bytes([0xff, 0xd8, 0xff, 0xe0]), 'foto.png');
    assert.equal(result.format, 'jpg');
    assert.equal(result.extensionFormat, 'png');
    assert.equal(result.mismatch, true);
  });

  it('distingue WMA y WMV por la extensión dentro del contenedor ASF', () => {
    const asf = bytes([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]);
    assert.equal(detectFormat(asf, 'cancion.wma').format, 'wma');
    assert.equal(detectFormat(asf, 'video.wmv').format, 'wmv');
  });

  it('reconoce texto por el contenido con extensión de texto (UTF-8, UTF-16, Windows-1252)', () => {
    const utf8 = new TextEncoder().encode('Pedido nº 42 — entrega en Valencia\r\nCantidad:\t12\r\n');
    assert.equal(detectFormat(utf8, 'notas.txt').format, 'txt');
    assert.equal(detectFormat(utf8, 'registro.log').format, 'txt');
    assert.equal(detectFormat(utf8, 'tabla.csv').format, 'txt');
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x6f, 0x00, 0x6c, 0x00, 0x61, 0x00]);
    assert.equal(detectFormat(utf16, 'unicode.txt').format, 'txt');
    const cp1252 = new Uint8Array([0x41, 0xf1, 0x6f, 0x20, 0x80, 0x0d, 0x0a]); // «Año €» en Windows-1252
    assert.equal(detectFormat(cp1252, 'antiguo.txt').format, 'txt');
    // Sin extensión de texto, el texto no se adivina; y un .txt binario no es texto.
    assert.equal(detectFormat(utf8, 'notas').format, null);
    assert.equal(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]), 'falso.txt').format, null);
  });

  it('no confunde un archivo binario cualquiera con MP3 si la extensión no lo indica', () => {
    assert.equal(detectFormat(bytes([0xff, 0xfb, 0x90, 0x64]), 'datos.bin').format, null);
  });
});

/** Cabecera de un ZIP con entradas sin comprimir (nombre y contenido). */
const zip = (...entries: [string, string][]): Uint8Array => {
  const out: number[] = [];
  for (const [name, data] of entries) {
    const header = new Array<number>(30).fill(0);
    header.splice(0, 4, 0x50, 0x4b, 0x03, 0x04);
    header[18] = data.length & 0xff;
    header[19] = (data.length >> 8) & 0xff;
    header[26] = name.length;
    out.push(...header);
    for (const ch of name + data) out.push(ch.charCodeAt(0));
  }
  return new Uint8Array(out);
};
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

describe('Detección de documentos de Office', () => {
  it('OOXML: la carpeta interna manda sobre la extensión', () => {
    const docx = zip(['[Content_Types].xml', '<Types/>'], ['_rels/.rels', '<R/>'], ['word/document.xml', '<w/>']);
    assert.equal(detectFormat(docx, 'informe.docx').format, 'docx');
    assert.equal(detectFormat(zip(['[Content_Types].xml', 'x'], ['xl/workbook.xml', 'x']), 'cuentas.xlsx').format, 'xlsx');
    assert.equal(detectFormat(zip(['[Content_Types].xml', 'x'], ['ppt/presentation.xml', 'x']), 'charla.ppsx').format, 'pptx');
    // Un Excel con extensión de Word se trata como Excel (y se avisa de la discrepancia).
    const wrong = detectFormat(zip(['xl/workbook.xml', 'x']), 'mal nombre.docx');
    assert.equal(wrong.format, 'xlsx');
    assert.equal(wrong.mismatch, true);
  });

  it('OOXML sin la carpeta en la cabecera: se acepta la extensión de Office, no otras', () => {
    const big = zip(['[Content_Types].xml', 'x'.repeat(5000)]).subarray(0, 4096);
    assert.equal(detectFormat(big, 'grande.pptx').format, 'pptx');
    assert.equal(detectFormat(big, 'comprimido.zip').format, null);
    assert.equal(detectFormat(big, 'libro.epub').format, null);
  });

  it('OpenDocument por su «mimetype»', () => {
    assert.equal(detectFormat(zip(['mimetype', 'application/vnd.oasis.opendocument.text']), 'carta.odt').format, 'odt');
    assert.equal(detectFormat(zip(['mimetype', 'application/vnd.oasis.opendocument.spreadsheet']), 'tabla.ods').format, 'ods');
    assert.equal(detectFormat(zip(['mimetype', 'application/vnd.oasis.opendocument.presentation']), 'charla.odp').format, 'odp');
    assert.equal(detectFormat(zip(['mimetype', 'application/vnd.oasis.opendocument.graphics']), 'dibujo.odg').format, null);
    // Aunque la extensión diga otra cosa, el contenido manda.
    assert.equal(detectFormat(zip(['mimetype', 'application/vnd.oasis.opendocument.text']), 'carta.docx').format, 'odt');
  });

  it('97-2003 (CFB) por la extensión; un DOCX/XLSX/PPTX dentro de un CFB está cifrado', () => {
    for (const [name, format] of [['viejo.doc', 'doc'], ['viejo.xls', 'xls'], ['viejo.ppt', 'ppt'], ['viejo.pps', 'ppt'], ['con clave.xlsx', 'xlsx']] as const) {
      assert.equal(detectFormat(bytes(CFB), name).format, format, name);
    }
    assert.equal(detectFormat(bytes(CFB), 'correo.msg').format, null);
    assert.equal(detectFormat(bytes(CFB), 'instalador.msi').format, null);
    assert.ok(isEncryptedOoxml(bytes(CFB), 'xlsx'));
    assert.ok(!isEncryptedOoxml(bytes(CFB), 'xls'));
    assert.ok(!isEncryptedOoxml(zip(['word/document.xml', 'x']), 'docx'));
  });

  it('RTF por su firma, también con extensión .doc (equivalentes: sin aviso)', () => {
    const rtf = bytes('{\\rtf1\\ansi\\deff0 Hola}');
    assert.equal(detectFormat(rtf, 'carta.rtf').format, 'rtf');
    const asDoc = detectFormat(rtf, 'carta.doc');
    assert.equal(asDoc.format, 'rtf');
    assert.equal(asDoc.mismatch, false);
  });
});
