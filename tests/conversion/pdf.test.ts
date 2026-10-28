/**
 * PDF ↔ imágenes con archivos reales.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { loadSharp } from '../../electron/conversion/adapters/image';
import { openPdf, renderPage } from '../../electron/conversion/adapters/pdf';
import { runJob, type JobResult } from '../../electron/conversion/engine';
import type { FormatId, TargetId } from '../../src/types/formats';
import { listFiles, makePdf, makePng, makeRotatedJpeg, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

const noop = (): void => undefined;
const convert = (target: TargetId, files: { path: string; format: FormatId }[]): Promise<JobResult> =>
  runJob(spec(target, files), noop, new AbortController().signal);

describe('PDF ↔ imágenes (archivos reales)', () => {
  let dir = '';
  let multi = '';
  let single = '';

  before(async () => {
    dir = await makeTempDir('pdf');
    multi = path.join(dir, 'Informe trimestral.pdf');
    single = path.join(dir, 'una página.pdf');
    await makePdf(multi, 5, 5); // la página 5 es apaisada
    await makePdf(single, 1);
  });
  after(async () => {
    await removeDir(dir);
  });

  it('PDF de 5 páginas → JPG produce una carpeta con exactamente 5 imágenes', async () => {
    const before = await sha256(multi);
    const progress: number[] = [];
    const result = await runJob(spec('jpg', [{ path: multi, format: 'pdf' }]), (u) => u.fraction !== null && progress.push(u.fraction), new AbortController().signal);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const out = result.outputs[0];
    assert.equal(out?.kind, 'folder');
    assert.equal(out?.count, 5);
    assert.equal(path.basename(out?.output as string), 'Informe trimestral (JPG)');
    const files = await listFiles(out?.output as string);
    assert.deepEqual(files, ['Informe trimestral-01.jpg', 'Informe trimestral-02.jpg', 'Informe trimestral-03.jpg', 'Informe trimestral-04.jpg', 'Informe trimestral-05.jpg']);

    const sharp = await loadSharp();
    const first = await sharp(path.join(out?.output as string, files[0] as string)).metadata();
    // A4 (595×842 pt) a 200 ppp → 1653×2339 px aprox.
    assert.ok(Math.abs((first.width as number) - 1653) <= 2, `ancho ${first.width}`);
    assert.ok(Math.abs((first.height as number) - 2339) <= 2, `alto ${first.height}`);
    const landscape = await sharp(path.join(out?.output as string, files[4] as string)).metadata();
    assert.ok((landscape.width as number) > (landscape.height as number), 'la página apaisada se conserva apaisada');

    assert.ok(progress.length >= 5, 'el progreso avanza página a página');
    assert.equal(progress.at(-1), 1);
    assert.equal(await sha256(multi), before, 'el PDF original no debe cambiar');
  });

  it('PDF de una página → PNG produce un único archivo junto al original', async () => {
    const result = await convert('png', [{ path: single, format: 'pdf' }]);
    assert.equal(result.outputs[0]?.kind, 'file');
    assert.equal(path.basename(result.outputs[0]?.output as string), 'una página.png');
  });

  it('PDF → TIFF agrupa las páginas del mismo tamaño en un TIFF multipágina', async () => {
    const four = path.join(dir, 'cuatro.pdf');
    await makePdf(four, 4);
    const result = await convert('tiff', [{ path: four, format: 'pdf' }]);
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const sharp = await loadSharp();
    const meta = await sharp(result.outputs[0]?.output as string).metadata();
    assert.equal(meta.pages, 4);
  });

  it('PDF → TXT extrae el texto de todas las páginas', async () => {
    const result = await convert('txt', [{ path: multi, format: 'pdf' }]);
    const text = await fs.readFile(result.outputs[0]?.output as string, 'utf8');
    for (let i = 1; i <= 5; i++) assert.ok(text.includes(`Pagina ${i} de prueba EFC`), `falta la página ${i}`);
  });

  it('un PDF dañado produce un error controlado y ningún archivo', async () => {
    const broken = path.join(dir, 'roto.pdf');
    await fs.writeFile(broken, '%PDF-1.7\n1 0 obj << /Type /Catalog >>\nbasura sin estructura');
    const result = await convert('jpg', [{ path: broken, format: 'pdf' }]);
    assert.equal(result.outputs.length, 0);
    assert.equal(result.failures.length, 1);
    assert.ok(['corrupt', 'unknown'].includes(result.failures[0]?.code as string), result.failures[0]?.code);
    assert.ok(!(await fs.readdir(dir)).some((n) => n.startsWith('roto') && n !== 'roto.pdf'));
  });

  it('imagen → PDF crea una página con las proporciones de la imagen', async () => {
    const png = path.join(dir, 'diagrama.png');
    await makePng(png, 300, 150);
    const result = await convert('pdf', [{ path: png, format: 'png' }]);
    const doc = await PDFDocument.load(await fs.readFile(result.outputs[0]?.output as string));
    assert.equal(doc.getPageCount(), 1);
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(Math.abs(width / height - 2) < 0.01, `proporción ${width}/${height}`);
  });

  it('JPG con orientación EXIF → PDF se incrusta sin recomprimir y se ve derecho', async () => {
    const jpg = path.join(dir, 'retrato.jpg');
    await makeRotatedJpeg(jpg);
    const result = await convert('pdf', [{ path: jpg, format: 'jpg' }]);
    const out = result.outputs[0]?.output as string;
    const bytes = await fs.readFile(out);
    const original = await fs.readFile(jpg);
    assert.ok(bytes.includes(original.subarray(200, 400)), 'los bytes JPEG originales están dentro del PDF');

    // Renderizado: la página debe ser vertical y con el rojo arriba, como la imagen orientada.
    const pdf = await openPdf(out);
    try {
      const page = await renderPage(pdf, 1, 72);
      assert.ok(page.height > page.width, `página ${page.width}×${page.height}`);
      const at = (x: number, y: number): number[] => {
        const i = (Math.floor(y) * page.width + Math.floor(x)) * 4;
        return [...page.data.slice(i, i + 3)];
      };
      const top = at(page.width / 2, page.height * 0.1);
      const bottom = at(page.width / 2, page.height * 0.9);
      assert.ok((top[0] as number) > 150 && (top[2] as number) < 100, `arriba rojo: ${top}`);
      assert.ok((bottom[2] as number) > 150 && (bottom[0] as number) < 100, `abajo azul: ${bottom}`);
    } finally {
      await pdf.close();
    }
  });

  it('varias imágenes → «Unir» crea un único PDF en orden natural de nombre', async () => {
    const names = ['scan 10.png', 'scan 2.png', 'scan 1.png'];
    for (const n of names) await makePng(path.join(dir, n), 100 + names.indexOf(n) * 10, 100);
    const result = await convert(
      'pdf-merge',
      names.map((n) => ({ path: path.join(dir, n), format: 'png' as const })),
    );
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    assert.equal(result.outputs.length, 1);
    assert.equal(path.basename(result.outputs[0]?.output as string), 'scan 1_combinado.pdf');
    const doc = await PDFDocument.load(await fs.readFile(result.outputs[0]?.output as string));
    assert.equal(doc.getPageCount(), 3);
    // Orden natural: scan 1 (120 px), scan 2 (110 px), scan 10 (100 px) → anchos decrecientes.
    const widths = doc.getPages().map((p) => p.getWidth());
    assert.ok((widths[0] as number) > (widths[1] as number) && (widths[1] as number) > (widths[2] as number), `anchos ${widths}`);
  });
});
