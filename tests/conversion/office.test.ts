/**
 * Word, Excel y PowerPoint → PDF con el Office real del equipo (solo en Windows con Office instalado;
 * si no lo hay, estas pruebas se omiten). Los documentos de tests/fixtures/office se crearon con Office.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { extractPageText, openPdf } from '../../electron/conversion/adapters/pdf';
import type { OfficeRunner } from '../../electron/conversion/adapters/office';
import { detectFormat } from '../../electron/conversion/detect';
import { runJob, type JobFile, type JobResult, type JobSpec } from '../../electron/conversion/engine';
import { TEMP_PREFIX } from '../../electron/conversion/output-path';
import type { OfficeApps } from '../../electron/conversion/registry';
import { detectOffice } from '../../electron/windows/office';
import { listFiles, makeTempDir, removeDir, sha256, spec } from '../helpers/fixtures';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'office');
const RUNNER: OfficeRunner = {
  powershell: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  script: path.join(__dirname, '..', '..', 'electron', 'conversion', 'adapters', 'efc-office.ps1'),
};

/** Procesos de Word en marcha (para comprobar que EFC no deja ninguno abierto). */
function wordProcesses(): Set<number> {
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return new Set(out.split(/\r?\n/).filter((l) => l.startsWith('"')).map((l) => Number(l.split('","')[1])));
}

async function pdfText(file: string): Promise<string[]> {
  const pdf = await openPdf(file);
  try {
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) pages.push(await extractPageText(pdf, i));
    return pages;
  } finally {
    await pdf.close();
  }
}

describe('Office → PDF (Office real)', async () => {
  const office: OfficeApps | null = await detectOffice();
  const skip = !office ? 'Office no está instalado en este equipo' : false;
  let dir = '';

  /** Copia un documento de ejemplo con un nombre difícil y devuelve su ruta y formato detectado. */
  async function place(fixture: string, name: string): Promise<JobFile> {
    const target = path.join(dir, name);
    await fs.copyFile(path.join(FIXTURES, fixture), target);
    const header = (await fs.readFile(target)).subarray(0, 4096);
    const format = detectFormat(header, name).format;
    assert.ok(format, `formato de ${name}`);
    return { path: target, format };
  }

  function job(files: JobFile[]): JobSpec {
    return { ...spec('pdf', files), office: { ...RUNNER, apps: office as OfficeApps } };
  }

  async function convert(files: JobFile[], signal = new AbortController().signal): Promise<JobResult> {
    return runJob(job(files), () => undefined, signal);
  }

  before(async () => {
    if (!skip) dir = await makeTempDir('office');
  });
  after(async () => {
    if (dir) await removeDir(dir);
  });

  const documents: [fixture: string, name: string, pages: number, text: RegExp][] = [
    ['word.docx', 'informe de ventas ñ.docx', 1, /canción, pingüino, ¿qué tal\? ¡Hola!/],
    ['word.doc', 'informe antiguo.doc', 1, /canción/],
    ['word.rtf', 'carta (borrador).rtf', 1, /Segundo párrafo/],
    ['word.odt', 'carta & libre.odt', 1, /pingüino/],
    ['excel.xlsx', 'cuentas #1.xlsx', 2, /Hoja Ventas/],
    ['excel.xls', 'cuentas antiguas.xls', 2, /Hoja Gastos/],
    ['excel.ods', 'cuentas libres.ods', 2, /Hoja Ventas/],
    ['power.pptx', 'charla final.pptx', 2, /Diapositiva 1/],
    ['power.ppsx', 'charla en bucle.ppsx', 2, /Diapositiva 2/],
    ['power.ppt', 'charla antigua.ppt', 2, /Diapositiva 1/],
    ['power.odp', 'charla libre.odp', 2, /Diapositiva 2/],
  ];

  for (const [fixture, name, pages, text] of documents) {
    it(`${name} → PDF con ${pages} página(s) y su texto`, { skip, timeout: 120_000 }, async () => {
      const file = await place(fixture, name);
      const before = await sha256(file.path);
      const result = await convert([file]);
      assert.deepEqual(result.failures, []);
      const output = result.outputs[0]?.output ?? '';
      assert.equal(path.basename(output), `${path.parse(name).name}.pdf`);
      const content = await pdfText(output);
      assert.equal(content.length, pages);
      assert.match(content.join('\n'), text);
      assert.equal(await sha256(file.path), before, 'el original no cambia');
    });
  }

  it('Excel: todas las hojas visibles y ninguna oculta', { skip, timeout: 120_000 }, async () => {
    const result = await convert([await place('excel.xlsx', 'hojas.xlsx')]);
    const content = (await pdfText(result.outputs[0]?.output ?? '')).join('\n');
    assert.match(content, /Hoja Ventas/);
    assert.match(content, /Hoja Gastos/);
    assert.doesNotMatch(content, /Hoja Oculta/);
  });

  it('varios documentos de Word, Excel y PowerPoint en un lote', { skip, timeout: 240_000 }, async () => {
    const files = [await place('word.docx', 'lote 1.docx'), await place('excel.xlsx', 'lote 2.xlsx'), await place('power.pptx', 'lote 3.pptx')];
    const result = await convert(files);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.outputs.map((o) => path.basename(o.output)), ['lote 1.pdf', 'lote 2.pdf', 'lote 3.pdf']);
  });

  it('con contraseña o vacío: aviso claro y sin archivo', { skip, timeout: 240_000 }, async () => {
    const cases: [string, string, string][] = [
      ['word-clave.docx', 'clave.docx', 'doc_password'], // cifrado: se detecta sin abrir Office
      ['word-clave.doc', 'clave.doc', 'doc_password'], // Word responde «contraseña incorrecta»
      ['excel-clave.xlsx', 'clave.xlsx', 'doc_password'],
      ['power-clave.pptx', 'clave.pptx', 'doc_password'],
      ['excel-vacio.xlsx', 'vacío.xlsx', 'nothing_to_print'],
    ];
    for (const [fixture, name, code] of cases) {
      const result = await convert([await place(fixture, name)]);
      assert.equal(result.outputs.length, 0, name);
      assert.equal(result.failures[0]?.code, code, `${name}: ${result.failures[0]?.detail}`);
    }
  });

  for (const delay of [300, 1500, 4000]) {
    it(`cancelar a los ${delay} ms no deja PDF, temporales ni Word abierto`, { skip, timeout: 120_000 }, async () => {
      const file = await place('word.docx', `cancelado ${delay}.docx`);
      const before = wordProcesses();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      const result = await convert([file], controller.signal);
      assert.equal(result.cancelled, true);
      assert.ok(!(await listFiles(dir)).includes(`cancelado ${delay}.pdf`));
      // El Word que abrió EFC debe desaparecer (se da un margen para que Windows lo cierre).
      let orphans: number[] = [];
      for (let i = 0; i < 20; i++) {
        orphans = [...wordProcesses()].filter((pid) => !before.has(pid));
        if (orphans.length === 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.deepEqual(orphans, [], 'Word abierto por EFC tras cancelar');
    });
  }

  it('no quedan temporales en la carpeta ni en la del sistema', { skip }, async () => {
    for (const name of await listFiles(dir)) assert.ok(!name.startsWith(TEMP_PREFIX), name);
    const leftovers = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith(`${TEMP_PREFIX}t${process.pid}x`));
    assert.deepEqual(leftovers, []);
  });
});
