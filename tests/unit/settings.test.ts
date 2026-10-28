import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, sanitizeConfig, type AppConfig } from '../../electron/main/config';
import { placeFlyout } from '../../electron/main/placement';
import { imageQualityOf, patchFor, settingsValues, shortcutProblem } from '../../electron/main/settings-model';
import { glassFactor } from '../../src/lib/settings-options';
import { keyToShortcut, type KeyPress } from '../../src/lib/shortcut-keys';

const config = (patch: Partial<AppConfig> = {}): AppConfig => sanitizeConfig({ ...DEFAULT_CONFIG, ...patch });

describe('Ajustes: modelo', () => {
  it('muestra la configuración tal cual, con la calidad como nivel', () => {
    const v = settingsValues(config());
    assert.equal(v.shortcut, 'CommandOrControl+Shift+E');
    assert.equal(v.imageQuality, 'high');
    assert.equal(v.wheelTransparency, 50);
    assert.equal(v.language, 'es');
    assert.equal(imageQualityOf({ ...config().conversion, jpegQuality: 77 }), 'custom');
  });

  it('cada cambio se traduce a la configuración y se valida', () => {
    const c = config();
    assert.deepEqual(patchFor(c, { key: 'backdropBlur', value: false }), {
      ok: true,
      patch: { backdropBlur: false },
    });
    const max = patchFor(c, { key: 'imageQuality', value: 'max' });
    assert.ok(max.ok && max.patch.conversion?.jpegQuality === 95 && max.patch.conversion.avifQuality === 75);
    assert.ok(max.ok && max.patch.conversion?.pdfDpi === 200, 'el resto de la calidad no cambia');
    const video = patchFor(c, { key: 'shrinkVideoMaxSide', value: 854 });
    assert.ok(video.ok && video.patch.conversion?.shrinkVideoMaxSide === 854);
    assert.deepEqual(patchFor(c, { key: 'wheelTransparency', value: 140 }), {
      ok: true,
      patch: { wheelTransparency: 100 },
    });
    // Valores que no son de ninguna opción, o de tipo equivocado, se rechazan.
    assert.equal(patchFor(c, { key: 'pdfDpi', value: 250 }).ok, false);
    assert.equal(patchFor(c, { key: 'imageQuality', value: 'custom' }).ok, false);
    assert.equal(patchFor(c, { key: 'launchAtLogin', value: 'sí' as unknown as boolean }).ok, false);
    assert.deepEqual(patchFor(c, { key: 'language', value: 'en' }), { ok: true, patch: { language: 'en' } });
    assert.equal(patchFor(c, { key: 'language', value: 'fr' as 'es' }).ok, false);
  });

  it('un atajo necesita Ctrl, Alt o Win (salvo las teclas de función)', () => {
    assert.equal(shortcutProblem('CommandOrControl+Shift+K'), null);
    assert.equal(shortcutProblem('Alt+5'), null);
    assert.equal(shortcutProblem('F9'), null);
    assert.match(shortcutProblem('Shift+K') ?? '', /Ctrl, Alt o Win/);
    assert.match(shortcutProblem('CommandOrControl+Tab') ?? '', /letra/);
    assert.equal(patchFor(config(), { key: 'shortcut', value: 'K' }).ok, false);
  });

  it('config.json antiguo sin las claves nuevas usa los valores por defecto', () => {
    const old = sanitizeConfig({
      shortcut: 'Alt+E',
      wheelTransparency: 'mucha',
      language: 'fr',
    });
    assert.equal(old.wheelTransparency, 50);
    assert.equal(old.language, 'es');
    assert.equal(old.shortcut, 'Alt+E');
    // Una tecla de función sola también se guarda.
    assert.equal(sanitizeConfig({ shortcut: 'F8' }).shortcut, 'F8');
  });

  it('la transparencia escala el cristal de la rueda', () => {
    assert.equal(glassFactor(0), 1.5);
    assert.equal(glassFactor(50), 1);
    assert.equal(glassFactor(100), 0.5);
    assert.equal(glassFactor(-20), 1.5);
  });
});

describe('Ajustes: grabar el atajo', () => {
  const k = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it('convierte la pulsación en acelerador y texto legible', () => {
    assert.deepEqual(keyToShortcut(k('KeyK', { ctrlKey: true, shiftKey: true })), {
      kind: 'ok',
      accelerator: 'CommandOrControl+Shift+K',
      label: 'Ctrl + Mayús + K',
    });
    assert.deepEqual(keyToShortcut(k('Digit7', { altKey: true })), {
      kind: 'ok',
      accelerator: 'Alt+7',
      label: 'Alt + 7',
    });
    assert.deepEqual(keyToShortcut(k('F8')), {
      kind: 'ok',
      accelerator: 'F8',
      label: 'F8',
    });
    assert.deepEqual(keyToShortcut(k('Space', { metaKey: true })), {
      kind: 'ok',
      accelerator: 'Super+Space',
      label: 'Win + Espacio',
    });
  });

  it('mientras solo hay modificadores, espera; las teclas no admitidas se rechazan', () => {
    assert.deepEqual(keyToShortcut(k('ControlLeft', { ctrlKey: true })), {
      kind: 'pending',
      label: 'Ctrl + …',
    });
    assert.equal(keyToShortcut(k('KeyK')).kind, 'invalid');
    assert.equal(keyToShortcut(k('KeyK', { shiftKey: true })).kind, 'invalid');
    assert.equal(keyToShortcut(k('Tab', { ctrlKey: true })).kind, 'invalid');
  });

  it('lo que acepta la interfaz también lo acepta el proceso principal', () => {
    for (const press of [k('KeyA', { ctrlKey: true }), k('Digit0', { altKey: true, shiftKey: true }), k('F24'), k('KeyZ', { metaKey: true })]) {
      const r = keyToShortcut(press);
      assert.ok(r.kind === 'ok' && shortcutProblem(r.accelerator) === null, JSON.stringify(press));
    }
  });
});

describe('Ajustes: colocación del panel', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };

  it('barra de tareas abajo: encima del icono, pegado a la barra', () => {
    const r = placeFlyout({ x: 1800, y: 1050, width: 24, height: 24 }, 400, 600, work);
    assert.deepEqual(r, { x: 1520, y: 440, width: 400, height: 600 });
  });

  it('barra arriba, a la izquierda y a la derecha', () => {
    assert.equal(
      placeFlyout({ x: 900, y: -30, width: 24, height: 24 }, 400, 600, {
        ...work,
        y: 40,
      }).y,
      40,
    );
    const left = placeFlyout({ x: -40, y: 500, width: 24, height: 24 }, 400, 600, { ...work, x: 48 });
    assert.equal(left.x, 48);
    const right = placeFlyout({ x: 1940, y: 900, width: 24, height: 24 }, 400, 600, work);
    assert.equal(right.x, 1520);
    assert.ok(right.y + right.height <= 1040);
  });

  it('icono en la ventana de iconos ocultos (dentro del área): el panel va encima, sin salirse', () => {
    const r = placeFlyout({ x: 1700, y: 960, width: 24, height: 24 }, 400, 600, work);
    assert.equal(r.y, 360);
    const small = placeFlyout({ x: 100, y: 100, width: 24, height: 24 }, 400, 600, work);
    assert.deepEqual([small.x, small.y], [0, 0]);
  });
});
