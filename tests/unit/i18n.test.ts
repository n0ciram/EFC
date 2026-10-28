import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availableTargets, explainNoTargets, type EngineCaps } from '../../electron/conversion/registry';
import { sanitizeConfig } from '../../electron/main/config';
import type { Job } from '../../electron/main/jobs';
import { patchFor, shortcutProblem } from '../../electron/main/settings-model';
import { jobToToast } from '../../electron/main/toast-presenter';
import { parseAccelerator } from '../../electron/windows/shortcut';
import { paginate } from '../../src/components/pagination';
import { formatBytes, languageFromInstallerId, languageFromLocale, LANGUAGES, messages } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { es } from '../../src/i18n/es';
import { keyToShortcut } from '../../src/lib/shortcut-keys';

/** Todos los textos de un diccionario (las funciones se llaman con valores de ejemplo). */
function allTexts(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const out = (value as (...args: unknown[]) => unknown)(2, 'X', 'page');
    return typeof out === 'string' ? [[`${path}()`, out]] : [];
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => allTexts(v, path ? `${path}.${k}` : k));
  return [];
}

const caps: EngineCaps = { image: true, pdf: true, ffmpeg: null, office: { word: true, excel: false, powerpoint: false } };

describe('Idiomas: diccionarios', () => {
  it('el inglés tiene todos los textos del español y ninguno vacío', () => {
    const enTexts = allTexts(en);
    assert.deepEqual(
      enTexts.map(([k]) => k),
      allTexts(es).map(([k]) => k),
    );
    for (const [key, text] of enTexts) assert.ok(text.trim().length > 0, `vacío: ${key}`);
  });

  it('en inglés no queda nada en español', () => {
    for (const [key, text] of allTexts(en)) {
      assert.doesNotMatch(text, /[áéíóúñ¿¡]|Mayús|Ajustes|archivo|página/i, `${key}: «${text}»`);
    }
  });

  it('los idiomas que se pueden elegir se llaman en su propio idioma', () => {
    assert.deepEqual(LANGUAGES, [
      { value: 'es', label: 'Español' },
      { value: 'en', label: 'English' },
    ]);
  });

  it('idioma inicial: el del instalador o, si no, el de Windows', () => {
    assert.equal(languageFromInstallerId('3082'), 'es');
    assert.equal(languageFromInstallerId('1034\r\n'), 'es');
    assert.equal(languageFromInstallerId('1033'), 'en');
    assert.equal(languageFromInstallerId('2057'), 'en');
    assert.equal(languageFromInstallerId('1036'), null);
    assert.equal(languageFromInstallerId('nada'), null);
    assert.equal(languageFromLocale('es-ES'), 'es');
    assert.equal(languageFromLocale('es-419'), 'es');
    assert.equal(languageFromLocale('en-GB'), 'en');
    assert.equal(languageFromLocale('fr-FR'), 'en');
    assert.equal(sanitizeConfig({}, { language: 'en' }).language, 'en');
    assert.equal(sanitizeConfig({ language: 'es' }, { language: 'en' }).language, 'es', 'lo guardado manda');
    assert.equal(sanitizeConfig({ language: 'fr' }).language, 'es');
  });

  it('números y tamaños con el formato de cada idioma', () => {
    assert.equal(formatBytes(1258291, 'es'), '1,2 MB');
    assert.equal(formatBytes(1258291, 'en'), '1.2 MB');
    assert.equal(es.percent(40), '40\u00a0%');
    assert.equal(en.percent(40), '40%');
  });
});

describe('Idiomas: textos visibles en inglés', () => {
  it('rueda: destinos, herramientas y explicaciones', () => {
    const pdf = availableTargets([{ format: 'pdf' }], caps, 'en');
    assert.deepEqual(
      pdf.slice(0, 4).map((t) => [t.label, t.description]),
      [
        ['JPG', 'Pages as JPG'],
        ['SHRINK', 'Lighter PDF'],
        ['SPLIT', 'One PDF per page'],
        ['ROTATE', 'Rotate 90° clockwise'],
      ],
    );
    assert.equal(availableTargets([{ format: 'png' }, { format: 'jpg' }], caps, 'en').find((t) => t.id === 'pdf-merge')?.label, 'MERGE');
    assert.equal(availableTargets([{ format: 'docx' }], caps, 'en')[0]?.description, 'PDF document');
    assert.equal(explainNoTargets([{ format: 'xlsx' }], caps, 'en'), 'Converting XLSX to PDF requires Microsoft Excel to be installed.');
    assert.equal(explainNoTargets([{ format: 'mp3' }], caps, 'en'), 'FFmpeg isn’t available: MP3 can’t be converted.');
    const group = paginate(pdf, undefined, messages('en'))
      .flat()
      .find((p) => p.kind === 'group');
    // La esfera resume lo que hay dentro a partir de las etiquetas ya traducidas.
    assert.ok(group?.kind === 'group' && group.info.caption === 'Tools' && group.info.description === 'Shrink, split…');
  });

  it('avisos de progreso, resultado y error', () => {
    const job: Job = {
      id: 'a',
      key: 'k',
      target: { id: 'jpg', format: 'jpg', label: 'JPG', description: 'JPEG image', icon: 'photo', engine: 'image' },
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
    };
    const running = jobToToast(job, 'en');
    assert.equal(running.title, 'Converting to JPG');
    assert.equal(running.meta, '0 of 1 processed · 40%');
    const failed = jobToToast({ ...job, state: 'failed', error: { code: 'corrupt', message: 'El archivo está dañado…' } }, 'en');
    assert.equal(failed.title, 'Couldn’t convert');
    assert.equal(failed.detail, 'foto.png: The file is damaged or isn’t in a valid format.');
    const done = jobToToast(
      { ...job, state: 'done', result: { outputs: [{ source: 'C:\\x\\foto.png', output: 'C:\\x\\foto.jpg', kind: 'file', count: 1 }], failures: [], skipped: [], cancelled: false } },
      'en',
    );
    assert.deepEqual([done.title, done.detail, done.meta], ['Saved', 'foto.jpg', '1 of 1 processed']);
    const shrink = jobToToast(
      {
        ...job,
        target: { id: 'shrink', format: 'png', label: 'SHRINK', description: 'Lighter, for sharing', icon: 'shrink', engine: 'image-shrink' },
        state: 'done',
        result: {
          outputs: [{ source: 'a', output: 'C:\\x\\foto_shrunk.png', kind: 'file', count: 1, inputBytes: 9017753, outputBytes: 370688 }],
          failures: [],
          skipped: [],
          cancelled: false,
        },
      },
      'en',
    );
    assert.equal(shrink.meta, '8.6 MB → 362 KB · −96%');
  });

  it('atajo: nombres de teclas y avisos', () => {
    assert.equal(parseAccelerator('CommandOrControl+Shift+Space', en.keys)?.label, 'Ctrl + Shift + Space');
    assert.equal(parseAccelerator('CommandOrControl+Shift+E')?.label, 'Ctrl + Mayús + E');
    const k = { code: 'KeyK', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
    assert.deepEqual(keyToShortcut(k, en), { kind: 'ok', accelerator: 'CommandOrControl+Shift+K', label: 'Ctrl + Shift + K' });
    assert.deepEqual(keyToShortcut({ ...k, ctrlKey: false }, en), { kind: 'invalid', message: 'Combine it with Ctrl, Alt or Win.' });
    assert.equal(shortcutProblem('K', en), 'Combine it with Ctrl, Alt or Win.');
    assert.deepEqual(patchFor(sanitizeConfig({}), { key: 'pdfDpi', value: 7 }, en), { ok: false, message: 'Invalid value.' });
  });
});
