/**
 * Texto (.txt) → PDF y DOCX con archivos reales: se abre el resultado y se comprueba su contenido.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { extractPageText, openPdf } from '../../electron/conversion/adapters/pdf';
import { unzip } from '../../electron/conversion/adapters/text';
import { runJob, type JobResult, type ProgressUpdate } from '../../electron/conversion/engine';
import type { TargetId } from '../../src/types/formats';
import { listFiles, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

const FONT = path.join(__dirname, '..', '..', 'resources', 'fonts', 'DejaVuSansMono.ttf');

async function convert(target: TargetId, file: string, onProgress: (u: ProgressUpdate) => void = () => undefined): Promise<JobResult> {
  const job = { ...spec(target, [{ path: file, format: 'txt' }]), fontPath: FONT };
  return runJob(job, onProgress, new AbortController().signal);
}

async function pdfText(file: string): Promise<{ pages: number; text: string[] }> {
  const pdf = await openPdf(file);
  try {
    const text: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) text.push(await extractPageText(pdf, i));
    return { pages: pdf.numPages, text };
  } finally {
    await pdf.close();
  }
}

describe('Texto → PDF y Word (archivos reales)', () => {
  let dir = '';
  const sample = [
    'Pedido nº 42 — entrega en Valencia',
    'Cliente:\tFábrica Ñandú, S. L.',
    'Importe:\t1.250,00 €  (¿pagado? ¡sí!)',
    'Ελληνικά · Кириллица · «comillas» “tipográficas”',
    'Una línea muy larga '.repeat(12).trim(),
    '\fSegunda página tras un salto de página',
  ].join('\r\n');

  before(async () => {
    dir = await makeTempDir('texto');
    await fs.writeFile(path.join(dir, 'notas del pedido.txt'), sample, 'utf8');
    // Windows-1252 sin BOM: «Año 2026: 15 € — señal»
    await fs.writeFile(path.join(dir, 'antiguo.txt'), Buffer.from([0x41, 0xf1, 0x6f, 0x20, 0x32, 0x30, 0x32, 0x36, 0x3a, 0x20, 0x31, 0x35, 0x20, 0x80, 0x20, 0x97, 0x20, 0x73, 0x65, 0xf1, 0x61, 0x6c]));
    // UTF-16 LE con BOM
    await fs.writeFile(path.join(dir, 'unicode.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Diseño en UTF-16\r\nsegunda línea', 'utf16le')]));
    await fs.writeFile(path.join(dir, 'emoji.txt'), 'Entrega lista 😀 y 漢字\n', 'utf8');
    await fs.writeFile(path.join(dir, 'largo.txt'), Array.from({ length: 200 }, (_, i) => `Línea ${i + 1}`).join('\n'), 'utf8');
    await fs.writeFile(path.join(dir, 'en blanco.txt'), '   \r\n\t\r\n', 'utf8');
    await fs.writeFile(path.join(dir, 'marcas.txt'), 'Etiquetas <b> & "comillas"\n\tcon tabulador\n\fNueva página\n', 'utf8');
  });
  after(async () => {
    await removeDir(dir);
  });

  it('UTF-8 → PDF: conserva tildes, ñ, €, griego y cirílico, y respeta el salto de página', async () => {
    const source = path.join(dir, 'notas del pedido.txt');
    const before = await sha256(source);
    const result = await convert('pdf', source);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0];
    assert.equal(path.basename(out?.output as string), 'notas del pedido.pdf');
    assert.equal(out?.note, undefined, 'no debería haber caracteres sustituidos');
    const { pages, text } = await pdfText(out?.output as string);
    assert.equal(pages, 2);
    const all = text.join('\n').replace(/\s+/g, ' ');
    for (const expected of ['Pedido nº 42 — entrega en Valencia', 'Fábrica Ñandú', '1.250,00 €', '¿pagado? ¡sí!', 'Ελληνικά', 'Кириллица', '«comillas»']) {
      assert.ok(all.includes(expected), `falta «${expected}» en: ${all.slice(0, 300)}`);
    }
    assert.match(text[1] ?? '', /Segunda página/);
    assert.equal(await sha256(source), before, 'el original no debe cambiar');
  });

  it('si el PDF ya existe crea «_converted» sin sobrescribir', async () => {
    const source = path.join(dir, 'notas del pedido.txt');
    const first = await sha256(path.join(dir, 'notas del pedido.pdf'));
    const result = await convert('pdf', source);
    assert.equal(path.basename(result.outputs[0]?.output as string), 'notas del pedido_converted.pdf');
    assert.equal(await sha256(path.join(dir, 'notas del pedido.pdf')), first);
  });

  it('Windows-1252 y UTF-16 se decodifican correctamente', async () => {
    const legacy = await convert('pdf', path.join(dir, 'antiguo.txt'));
    assert.match((await pdfText(legacy.outputs[0]?.output as string)).text.join(' '), /Año 2026: 15 € — señal/);
    const utf16 = await convert('pdf', path.join(dir, 'unicode.txt'));
    assert.match((await pdfText(utf16.outputs[0]?.output as string)).text.join(' '), /Diseño en UTF-16/);
  });

  it('avisa de los caracteres que la fuente no puede dibujar en lugar de ocultarlo', async () => {
    const result = await convert('pdf', path.join(dir, 'emoji.txt'));
    assert.equal(result.failures.length, 0);
    assert.equal(result.outputs[0]?.note, '3 caracteres sustituidos por «?»');
    assert.match((await pdfText(result.outputs[0]?.output as string)).text.join(' '), /Entrega lista \? y \?\?/);
  });

  it('un texto largo se reparte en páginas con progreso real por página', async () => {
    const steps: string[] = [];
    const result = await convert('pdf', path.join(dir, 'largo.txt'), (u) => u.step && steps.push(`${u.step.done}/${u.step.total}`));
    const { pages, text } = await pdfText(result.outputs[0]?.output as string);
    assert.equal(pages, 4); // 56 líneas por página A4
    assert.deepEqual(steps, ['1/4', '2/4', '3/4', '4/4']);
    assert.match(text[3] ?? '', /Línea 200/);
  });

  it('un texto vacío o solo con espacios no genera ningún archivo', async () => {
    const before = await listFiles(dir);
    const result = await convert('pdf', path.join(dir, 'en blanco.txt'));
    assert.equal(result.outputs.length, 0);
    assert.equal(result.failures[0]?.code, 'empty');
    assert.deepEqual(await listFiles(dir), before, 'no deben quedar temporales ni salidas');
  });

  it('TXT → DOCX: paquete válido, un párrafo por línea, tabuladores, salto de página y caracteres escapados', async () => {
    const result = await convert('docx', path.join(dir, 'marcas.txt'));
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const file = result.outputs[0]?.output as string;
    assert.equal(path.basename(file), 'marcas.docx');
    const data = await fs.readFile(file);
    assert.equal(data.subarray(0, 4).toString('hex'), '504b0304');
    const parts = unzip(data);
    assert.deepEqual([...parts.keys()], ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/document.xml']);
    const xml = (parts.get('word/document.xml') as Buffer).toString('utf8');
    assert.ok(xml.includes('Etiquetas &lt;b&gt; &amp; &quot;comillas&quot;'));
    assert.ok(xml.includes('<w:tab/><w:t xml:space="preserve">con tabulador</w:t>'));
    assert.ok(xml.includes('<w:br w:type="page"/>'));
    assert.ok(xml.includes('Nueva página'));
    assert.match((parts.get('docProps/core.xml') as Buffer).toString('utf8'), /<dc:title>marcas<\/dc:title>/);
  });

  it('TXT → DOCX conserva los caracteres que el PDF no podría dibujar', async () => {
    const result = await convert('docx', path.join(dir, 'emoji.txt'));
    const xml = (unzip(await fs.readFile(result.outputs[0]?.output as string)).get('word/document.xml') as Buffer).toString('utf8');
    assert.ok(xml.includes('Entrega lista 😀 y 漢字'));
    assert.equal(result.outputs[0]?.note, undefined);
  });
});
