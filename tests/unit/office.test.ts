import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { officeError, parseOfficeEvent } from '../../electron/conversion/adapters/office';

describe('Office: respuestas del script', () => {
  it('solo acepta eventos conocidos en JSON', () => {
    assert.deepEqual(parseOfficeEvent('{"event":"started","pids":[12]}'), { event: 'started', pids: [12] });
    assert.equal(parseOfficeEvent('{"event":"otra"}'), null);
    assert.equal(parseOfficeEvent('Windows PowerShell'), null);
    assert.equal(parseOfficeEvent(''), null);
  });

  it('traduce cada fallo al aviso adecuado', () => {
    assert.equal(officeError('word', { stage: 'open', hresult: '0x800A1520' }).code, 'doc_password');
    assert.equal(officeError('excel', { stage: 'open', hresult: '0x800A03EC' }).code, 'office_open');
    assert.equal(officeError('excel', { stage: 'empty', hresult: '0x800A03EC' }).code, 'nothing_to_print');
    assert.equal(officeError('powerpoint', { stage: 'start', hresult: '0x80040154' }).code, 'office_start');
    assert.equal(officeError('word', { stage: 'export', hresult: '0x800A1066' }).code, 'office_failed');
    // El detalle técnico (para el registro) conserva la aplicación, la fase y el código.
    assert.match(officeError('word', { stage: 'export', hresult: '0x1', detail: 'algo' }).detail ?? '', /word · export · 0x1 · algo/);
  });
});
