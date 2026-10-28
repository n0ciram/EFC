/**
 * Archivo grande: la conversión no debe bloquear el bucle de eventos del proceso que la ejecuta.
 * (En la aplicación, además, todo se ejecuta en un proceso de utilidad separado de la interfaz.)
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadSharp } from '../../electron/conversion/adapters/image';
import { runJob } from '../../electron/conversion/engine';
import { makeTempDir, removeDir, spec } from '../helpers/fixtures';

describe('Archivos grandes', () => {
  let dir = '';
  let big = '';

  before(async () => {
    dir = await makeTempDir('grandes');
    big = path.join(dir, 'panorámica enorme.png');
    const sharp = await loadSharp();
    await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } },
    })
      .png({ compressionLevel: 1 })
      .toFile(big);
  });
  after(async () => {
    await removeDir(dir);
  });

  it('PNG de 25 megapíxeles → JPG sin bloquear el bucle de eventos', async () => {
    let maxGap = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    const started = performance.now();
    const result = await runJob(spec('jpg', [{ path: big, format: 'png' }]), () => undefined, new AbortController().signal);
    clearInterval(timer);
    const elapsed = performance.now() - started;
    assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
    const sharp = await loadSharp();
    const meta = await sharp(result.outputs[0]?.output as string, { limitInputPixels: false }).metadata();
    assert.equal(meta.width, 5000);
    assert.equal(meta.height, 5000);
    assert.ok(maxGap < 250, `el bucle de eventos estuvo bloqueado ${Math.round(maxGap)} ms (conversión: ${Math.round(elapsed)} ms)`);
  });
});
