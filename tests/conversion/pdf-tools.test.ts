/**
 * Herramientas de PDF con archivos reales: unir (PDF e imágenes), separar, girar y reducir.
 * Los resultados se vuelven a abrir con pdf-lib y pdf.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, degrees } from 'pdf-lib';
import { loadSharp } from '../../electron/conversion/adapters/image';
import { extractPageText, openPdf, renderPage } from '../../electron/conversion/adapters/pdf';
import { runJob, type JobResult } from '../../electron/conversion/engine';
import type { FormatId, TargetId } from '../../src/types/formats';
import { listFiles, makePdf, makePng, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

const noop = (): void => undefined;

async function photoJpeg(width: number, height: number): Promise<Buffer> {
  const sharp = await loadSharp();
  return sharp({ create: { width, height, channels: 3, background: '#8ea4bb', noise: { type: 'gaussian', mean: 128, sigma: 24 } } }).jpeg({ quality: 92 }).toBuffer();
}

/** Imágenes de cada página del PDF: [ancho, alto, filtro]. */
async function imagesOf(file: string): Promise<[number, number, string][]> {
  const doc = await PDFDocument.load(await fs.readFile(file));
  const out: [number, number, string][] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      const n = (k: string): number => (obj.dict.get(PDFName.of(k)) as PDFNumber).asNumber();
      out.push([n('Width'), n('Height'), String(obj.dict.get(PDFName.of('Filter')))]);
    }
  }
  return out;
}

describe('Herramientas de PDF (archivos reales)', () => {
  let dir = '';
  const file = (name: string): string => path.join(dir, name);
  const run = (target: TargetId, files: [string, FormatId][]): Promise<JobResult> =>
    runJob(spec(target, files.map(([name, format]) => ({ path: file(name), format }))), noop, new AbortController().signal);

  before(async () => {
    dir = await makeTempDir('herramientas pdf');
    await makePdf(file('informe 2.pdf'), 5, 4); // la página 4 es apaisada
    await makePdf(file('informe 10.pdf'), 2);
    await makePdf(file('una página.pdf'), 1);
    await makePng(file('foto 5.png'), 400, 300);

    // «Escaneo»: 3 páginas A4 con una foto JPEG de 2480×3508 cada una, más una imagen sin comprimir
    // (FlateDecode RGB) y un logotipo con transparencia (SMask) que no debe tocarse.
    const scan = await PDFDocument.create();
    for (let i = 0; i < 3; i++) {
      const page = scan.addPage([595, 842]);
      page.drawImage(await scan.embedJpg(await photoJpeg(2480, 3508)), { x: 0, y: 0, width: 595, height: 842 });
      page.drawText(`Texto real de la pagina ${i + 1}`, { x: 40, y: 800, size: 16 });
    }
    const sharp = await loadSharp();
    const flat = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#335577', noise: { type: 'gaussian', mean: 120, sigma: 20 } } }).png().toBuffer();
    scan.getPage(0).drawImage(await scan.embedPng(flat), { x: 50, y: 50, width: 200, height: 150 });
    const logo = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><circle cx="450" cy="450" r="400" fill="#fb922c"/></svg>')).png().toBuffer();
    scan.getPage(1).drawImage(await scan.embedPng(logo), { x: 400, y: 600, width: 120, height: 120 });
    await fs.writeFile(file('escaneo pesado.pdf'), await scan.save());

    // Página ya girada 90° (para comprobar que el giro se suma).
    const turned = await PDFDocument.load(await fs.readFile(file('informe 10.pdf')));
    turned.getPage(1).setRotation(degrees(90));
    await fs.writeFile(file('ya girado.pdf'), await turned.save());

    // PDF cifrado (solo restricciones, contraseña de apertura vacía), con qpdf si está disponible.
    spawnSync('qpdf', ['--encrypt', '', 'propietario', '256', '--', file('una página.pdf'), file('protegido.pdf')]);
  });
  after(async () => {
    await removeDir(dir);
  });

  it('UNIR mezcla PDF e imágenes en orden natural de nombre («foto 5», «informe 2», «informe 10»)', async () => {
    const result = await run('pdf-merge', [
      ['informe 10.pdf', 'pdf'],
      ['foto 5.png', 'png'],
      ['informe 2.pdf', 'pdf'],
    ]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0];
    assert.equal(path.basename(out?.output as string), 'foto 5_combinado.pdf');
    const pdf = await openPdf(out?.output as string);
    try {
      assert.equal(pdf.numPages, 1 + 5 + 2);
      assert.equal((await extractPageText(pdf, 1)).trim(), ''); // la foto
      assert.match(await extractPageText(pdf, 2), /Pagina 1 de prueba/); // «informe 2», página 1
      assert.match(await extractPageText(pdf, 6), /Pagina 5 de prueba/); // «informe 2», página 5
      assert.match(await extractPageText(pdf, 7), /Pagina 1 de prueba/); // «informe 10», página 1
    } finally {
      await pdf.close();
    }
  });

  it('SEPARAR crea una carpeta con un PDF por página, con su texto', async () => {
    const before = await sha256(file('informe 2.pdf'));
    const result = await run('pdf-split', [['informe 2.pdf', 'pdf']]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0];
    assert.equal(out?.kind, 'folder');
    assert.equal(path.basename(out?.output as string), 'informe 2 (páginas)');
    const files = await listFiles(out?.output as string);
    assert.deepEqual(files, ['informe 2-01.pdf', 'informe 2-02.pdf', 'informe 2-03.pdf', 'informe 2-04.pdf', 'informe 2-05.pdf']);
    const fourth = await PDFDocument.load(await fs.readFile(path.join(out?.output as string, 'informe 2-04.pdf')));
    assert.equal(fourth.getPageCount(), 1);
    assert.ok(fourth.getPage(0).getWidth() > fourth.getPage(0).getHeight(), 'la página 4 sigue apaisada');
    assert.equal(await sha256(file('informe 2.pdf')), before);
  });

  it('SEPARAR un PDF de una página no crea nada y lo explica', async () => {
    const result = await run('pdf-split', [['una página.pdf', 'pdf']]);
    assert.equal(result.outputs.length, 0);
    assert.match(result.skipped[0]?.reason ?? '', /una página/);
  });

  it('GIRAR suma 90° a cada página (también a las ya giradas)', async () => {
    const result = await run('pdf-rotate', [['ya girado.pdf', 'pdf']]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    assert.equal(path.basename(result.outputs[0]?.output as string), 'ya girado_girado.pdf');
    const doc = await PDFDocument.load(await fs.readFile(result.outputs[0]?.output as string));
    assert.deepEqual(doc.getPages().map((p) => p.getRotation().angle), [90, 180]);
  });

  it('REDUCIR un PDF escaneado: imágenes a 1920 px en JPEG, mismo número de páginas y texto intacto', async () => {
    const before = await imagesOf(file('escaneo pesado.pdf'));
    assert.equal(before.length, 6); // 3 fotos, 1 sin comprimir, logotipo y su máscara
    const result = await run('shrink', [['escaneo pesado.pdf', 'pdf']]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0];
    assert.equal(path.basename(out?.output as string), 'escaneo pesado_reducido.pdf');
    assert.ok((out?.outputBytes as number) < (out?.inputBytes as number) * 0.6, `${out?.inputBytes} → ${out?.outputBytes}`);
    const after = await imagesOf(out?.output as string);
    // Las 3 fotos y la imagen sin comprimir se reducen; el logotipo con transparencia y su máscara, no.
    const big = after.filter(([w, h]) => Math.max(w, h) === 1920);
    assert.equal(big.length, 3, JSON.stringify(after));
    assert.ok(after.some(([w, h, f]) => w === 1600 && h === 1200 && f === '/DCTDecode'), 'la imagen sin comprimir pasa a JPEG');
    assert.equal(after.filter(([w]) => w === 900).length, 2, 'logotipo y máscara intactos');
    const pdf = await openPdf(out?.output as string);
    try {
      assert.equal(pdf.numPages, 3);
      assert.match(await extractPageText(pdf, 2), /Texto real de la pagina 2/);
      const page = await renderPage(pdf, 2, 50);
      assert.ok(page.width > 300 && page.height > 400);
    } finally {
      await pdf.close();
    }
  });

  it('REDUCIR un PDF que solo tiene texto no crea una copia inútil', async () => {
    const result = await run('shrink', [['informe 10.pdf', 'pdf']]);
    assert.equal(result.outputs.length, 0);
    assert.match(result.skipped[0]?.reason ?? '', /Ya ocupa poco/);
  });

  it('un PDF cifrado se rechaza con un mensaje claro y sin crear archivos', { skip: spawnSync('qpdf', ['--version']).status === 0 ? false : 'qpdf no disponible' }, async () => {
    const before = await listFiles(dir);
    const rotate = await run('pdf-rotate', [['protegido.pdf', 'pdf']]);
    assert.equal(rotate.failures[0]?.code, 'protected');
    const merge = await run('pdf-merge', [
      ['informe 10.pdf', 'pdf'],
      ['protegido.pdf', 'pdf'],
    ]);
    assert.equal(merge.failures[0]?.code, 'protected');
    assert.match(merge.failures[0]?.detail ?? '', /protegido\.pdf/);
    assert.deepEqual(await listFiles(dir), before);
  });
});
