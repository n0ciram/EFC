/**
 * Lo que crea EFC lleva nombres en el idioma de la interfaz: «_combinado», «_girado», «(páginas)»…
 * en español y «_merged», «_rotated», «(pages)»… en inglés.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { promises as fs } from 'node:fs';
import { runJob, type JobResult } from '../../electron/conversion/engine';
import type { Language } from '../../src/i18n';
import type { FormatId, TargetId } from '../../src/types/formats';
import { listFiles, makePdf, makeTempDir, removeDir, spec } from '../helpers/fixtures';

describe('Nombres de los resultados según el idioma (archivos reales)', () => {
  let dir = '';
  const file = (name: string): string => path.join(dir, name);
  const run = (target: TargetId, names: string[], language: Language): Promise<JobResult> =>
    runJob({ ...spec(target, names.map((name) => ({ path: file(name), format: 'pdf' as FormatId }))), language }, () => undefined, new AbortController().signal);

  before(async () => {
    dir = await makeTempDir('idioma');
    await makePdf(file('report.pdf'), 3);
    await makePdf(file('annex.pdf'), 1);
  });
  after(async () => {
    await removeDir(dir);
  });

  it('en inglés: «_rotated», «_merged» y la carpeta «(pages)» con títulos «page N»', async () => {
    await run('pdf-rotate', ['report.pdf'], 'en');
    await run('pdf-merge', ['report.pdf', 'annex.pdf'], 'en');
    const split = await run('pdf-split', ['report.pdf'], 'en');
    const names = await listFiles(dir);
    assert.ok(names.includes('report_rotated.pdf'), names.join(', '));
    assert.ok(names.includes('annex_merged.pdf') || names.includes('report_merged.pdf'), names.join(', '));
    assert.ok(names.includes('report (pages)'), names.join(', '));
    const first = (await fs.readdir(split.outputs[0]?.output ?? '')).sort()[0] as string;
    const doc = await PDFDocument.load(await fs.readFile(path.join(file('report (pages)'), first)));
    assert.equal(doc.getTitle(), 'report — page 1');
  });

  it('en español, como siempre: «_girado»', async () => {
    await run('pdf-rotate', ['annex.pdf'], 'es');
    assert.ok((await listFiles(dir)).includes('annex_girado.pdf'));
  });
});
