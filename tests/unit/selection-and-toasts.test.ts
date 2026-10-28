/**
 * Validación de la selección del Explorador y textos de las notificaciones.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Job } from '../../electron/main/jobs';
import { jobToToast } from '../../electron/main/toast-presenter';
import type { HelperItem } from '../../electron/windows/explorer-helper';
import { formatBytes, isSafePath, resolveSelection } from '../../electron/windows/selection';
import { makePng, makeTempDir, removeDir } from '../helpers/fixtures';

describe('Rutas seguras (Windows)', () => {
  const ok = ['C:\\Users\\Ana\\Imágenes\\foto 1.png', 'D:\\a.pdf', '\\\\servidor\\compartida\\informe.pdf', 'C:\\carpeta con & y % y !\\x.jpg'];
  const bad = [
    '\\\\?\\C:\\x.png',
    '\\\\.\\PhysicalDrive0',
    'relativa\\x.png',
    'C:\\x.png:flujo',
    'C:\\x\u0000.png',
    'C:\\a|b.png',
    '//servidor/x',
  ];
  for (const p of ok) it(`acepta ${p}`, () => assert.equal(isSafePath(p, 'win32'), true));
  for (const p of bad) it(`rechaza ${JSON.stringify(p)}`, () => assert.equal(isSafePath(p, 'win32'), false));
});

describe('Resolución de la selección', () => {
  let dir = '';
  before(async () => {
    dir = await makeTempDir('seleccion');
    await makePng(path.join(dir, 'imagen ñ.png'), 40, 30);
    await fs.writeFile(path.join(dir, 'vacío.png'), '');
    await fs.writeFile(path.join(dir, 'texto.txt'), 'hola, año próximo');
    await fs.writeFile(path.join(dir, 'datos.bin'), Buffer.from([0x00, 0x13, 0x88, 0xfe, 0x00, 0x01, 0x02, 0x03]));
    await fs.writeFile(path.join(dir, 'binario.txt'), Buffer.from([0x50, 0x4b, 0x00, 0x00, 0x01, 0x02, 0x00, 0x09]));
    await fs.mkdir(path.join(dir, 'subcarpeta'));
  });
  after(async () => {
    await removeDir(dir);
  });

  const item = (name: string, extra: Partial<HelperItem> = {}): HelperItem => ({
    path: path.join(dir, name),
    name,
    isFolder: false,
    isFileSystem: true,
    isLink: false,
    ...extra,
  });

  it('acepta archivos reales, detecta su formato y explica los rechazos', async () => {
    const result = await resolveSelection(
      [
        item('imagen ñ.png'),
        item('vacío.png'),
        item('texto.txt'),
        item('datos.bin'),
        item('binario.txt'),
        item('subcarpeta', { isFolder: true }),
        item('dentro.zip\\x.png', { isFileSystem: false }),
        item('acceso.lnk', { isLink: true }),
        item('no-existe.png'),
      ],
      process.platform,
    );
    assert.deepEqual(result.files.map((f) => f.format), ['png', 'txt']);
    assert.equal(result.folders, 1);
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.name, r.reason]));
    assert.equal(reasons['vacío.png'], 'empty');
    assert.equal(reasons['datos.bin'], 'unknownFormat');
    assert.equal(reasons['binario.txt'], 'unknownFormat', 'un .txt con contenido binario no es texto');
    assert.equal(reasons['dentro.zip\\x.png'], 'virtual');
    assert.equal(reasons['acceso.lnk'], 'shortcut');
    assert.equal(reasons['no-existe.png'], 'unreadable');
  });

  it('formatea tamaños en español', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1258291), '1,2 MB');
    assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
  });
});

describe('Notificaciones', () => {
  const baseJob = (patch: Partial<Job>): Job => ({
    id: 'j1',
    key: 'k',
    target: { id: 'jpg', format: 'jpg', label: 'JPG', description: 'Imagen JPEG', icon: 'photo', engine: 'image' },
    files: [{ path: 'C:\\x\\foto.png', name: 'foto.png', size: 10, format: 'png', extensionMismatch: false }],
    state: 'running',
    progress: 0.4,
    completed: 0,
    total: 1,
    currentIndex: 0,
    step: null,
    result: null,
    error: null,
    anchor: { x: 0, y: 0 },
    cancelRequested: false,
    ...patch,
  });

  it('muestra la operación en curso, el archivo y el progreso real', () => {
    const t = jobToToast(baseJob({}));
    assert.equal(t.title, 'Convirtiendo a JPG');
    assert.equal(t.detail, 'foto.png');
    assert.equal(t.meta, '0 de 1 procesados · 40\u00a0%');
    assert.equal(t.progress, 0.4);
    assert.deepEqual(t.actions, ['cancel']);
  });

  it('con Office dice qué aplicación convierte (si es una sola)', () => {
    const pdf = { id: 'pdf', format: 'pdf', label: 'PDF', description: 'Documento PDF', icon: 'document', engine: 'office-pdf' } as const;
    const file = (name: string, format: 'docx' | 'xlsx' | 'odt') => ({ path: `C:\\x\\${name}`, name, size: 10, format, extensionMismatch: false });
    assert.equal(jobToToast(baseJob({ target: pdf, files: [file('informe.docx', 'docx')] })).title, 'Convirtiendo a PDF con Word');
    assert.equal(jobToToast(baseJob({ target: pdf, files: [file('a.docx', 'docx'), file('b.odt', 'odt')], total: 2 })).title, 'Convirtiendo a PDF con Word');
    assert.equal(jobToToast(baseJob({ target: pdf, files: [file('a.docx', 'docx'), file('b.xlsx', 'xlsx')], total: 2 })).title, 'Convirtiendo a PDF');
  });

  it('en lotes muestra «N de M procesados»', () => {
    const files = [1, 2, 3].map((n) => ({ path: `C:\\x\\f${n}.png`, name: `f${n}.png`, size: 1, format: 'png' as const, extensionMismatch: false }));
    const t = jobToToast(baseJob({ files, total: 3, completed: 1, currentIndex: 1, progress: 0.5 }));
    assert.equal(t.detail, 'f2.png');
    assert.equal(t.meta, '1 de 3 procesados · 50\u00a0%');
  });

  it('en un PDF cuenta las páginas', () => {
    const t = jobToToast(baseJob({ progress: 0.25, step: { done: 3, total: 12, unit: 'page' } }));
    assert.equal(t.meta, '3 de 12 páginas · 25\u00a0%');
  });

  it('sin progreso medible no inventa un porcentaje', () => {
    const t = jobToToast(baseJob({ progress: null }));
    assert.equal(t.meta, '0 de 1 procesados');
  });

  it('al terminar indica que se guardó y permite mostrarlo', () => {
    const t = jobToToast(
      baseJob({
        state: 'done',
        result: { outputs: [{ source: 'C:\\x\\foto.png', output: 'C:\\x\\foto.jpg', kind: 'file', count: 1 }], failures: [], skipped: [], cancelled: false },
      }),
    );
    assert.equal(t.status, 'done');
    assert.equal(t.title, 'Guardado');
    assert.equal(t.detail, 'foto.jpg');
    assert.equal(t.meta, '1 de 1 procesados');
    assert.ok(t.actions.includes('reveal'));
  });

  it('al reducir muestra cuánto se ha ahorrado', () => {
    const target = { id: 'shrink' as const, format: 'jpg' as const, label: 'REDUCIR', description: 'Más ligera, para enviar', icon: 'shrink' as const, engine: 'image-shrink' as const };
    const running = jobToToast(baseJob({ target }));
    assert.equal(running.title, 'Reduciendo tamaño');
    const done = jobToToast(
      baseJob({
        target,
        state: 'done',
        result: { outputs: [{ source: 'C:\\x\\foto.jpg', output: 'C:\\x\\foto_reducido.jpg', kind: 'file', count: 1, inputBytes: 4404019, outputBytes: 389120 }], failures: [], skipped: [], cancelled: false },
      }),
    );
    assert.equal(done.detail, 'foto_reducido.jpg');
    assert.equal(done.meta, '4,2 MB → 380 KB · −91\u00a0%');
    const small = jobToToast(baseJob({ target, state: 'done', result: { outputs: [], failures: [], skipped: [{ source: 'C:\\x\\icono.jpg', reason: 'Ya ocupa poco' }], cancelled: false } }));
    assert.deepEqual([small.status, small.title, small.detail], ['info', 'Ya ocupa poco', 'icono.jpg: reducirlo no ahorraría espacio']);
  });

  it('un error queda visible con opción de reintentar', () => {
    const t = jobToToast(baseJob({ state: 'failed', error: { code: 'corrupt', message: 'El archivo está dañado.' } }));
    assert.equal(t.status, 'error');
    assert.ok(t.actions.includes('retry'));
    assert.match(t.detail, /foto\.png: El archivo está dañado/);
  });
});
