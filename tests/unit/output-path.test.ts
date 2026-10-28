import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  fileNameCandidates,
  folderNameCandidates,
  pageFileName,
  publishFile,
  publishFolder,
  splitFileName,
} from '../../electron/conversion/output-path';
import { makeTempDir, removeDir } from '../helpers/fixtures';

const take = <T>(gen: Generator<T>, n: number): T[] => {
  const out: T[] = [];
  for (const v of gen) {
    out.push(v);
    if (out.length === n) break;
  }
  return out;
};

describe('Nombres de salida', () => {
  it('sigue la regla imagen.jpg → imagen_converted.jpg → imagen_converted_2.jpg', () => {
    assert.deepEqual(take(fileNameCandidates('imagen', 'jpg'), 4), ['imagen.jpg', 'imagen_converted.jpg', 'imagen_converted_2.jpg', 'imagen_converted_3.jpg']);
  });

  it('separa base y extensión respetando puntos internos y archivos ocultos', () => {
    assert.deepEqual(splitFileName('mi.foto.final.png'), { base: 'mi.foto.final', ext: 'png' });
    assert.deepEqual(splitFileName('.bashrc'), { base: '.bashrc', ext: '' });
    assert.deepEqual(splitFileName('sin_extension'), { base: 'sin_extension', ext: '' });
  });

  it('numera las páginas con ceros suficientes', () => {
    assert.equal(pageFileName('informe', 0, 9, 'jpg'), 'informe-01.jpg');
    assert.equal(pageFileName('informe', 99, 120, 'png'), 'informe-100.png');
    assert.equal(pageFileName('informe', 4, 120, 'png'), 'informe-005.png');
  });

  it('nombra las carpetas de páginas como «nombre (JPG)», «nombre (JPG) 2»…', () => {
    assert.deepEqual(take(folderNameCandidates('doc', 'JPG'), 3), ['doc (JPG)', 'doc (JPG) 2', 'doc (JPG) 3']);
  });
});

describe('Publicación sin sobrescribir', () => {
  let dir = '';
  before(async () => {
    dir = await makeTempDir('salida');
  });
  after(async () => {
    await removeDir(dir);
  });

  it('nunca sobrescribe y usa el sufijo _converted y después numérico', async () => {
    await fs.writeFile(path.join(dir, 'foto ñ.jpg'), 'ORIGINAL');
    const t1 = path.join(dir, '.tmp1');
    await fs.writeFile(t1, 'UNO');
    const out1 = await publishFile(t1, dir, 'foto ñ', 'jpg');
    assert.equal(path.basename(out1), 'foto ñ_converted.jpg');

    const t2 = path.join(dir, '.tmp2');
    await fs.writeFile(t2, 'DOS');
    const out2 = await publishFile(t2, dir, 'foto ñ', 'jpg');
    assert.equal(path.basename(out2), 'foto ñ_converted_2.jpg');

    assert.equal(await fs.readFile(path.join(dir, 'foto ñ.jpg'), 'utf8'), 'ORIGINAL');
    assert.equal(await fs.readFile(out1, 'utf8'), 'UNO');
    assert.equal(await fs.readFile(out2, 'utf8'), 'DOS');
    await assert.rejects(fs.access(t1));
  });

  it('publica carpetas sin pisar otras existentes', async () => {
    await fs.mkdir(path.join(dir, 'doc (PNG)'));
    const temp = path.join(dir, '.tmpdir');
    await fs.mkdir(temp);
    await fs.writeFile(path.join(temp, 'doc-01.png'), 'x');
    const out = await publishFolder(temp, dir, 'doc', 'PNG');
    assert.equal(path.basename(out), 'doc (PNG) 2');
    assert.deepEqual(await fs.readdir(out), ['doc-01.png']);
  });
});
