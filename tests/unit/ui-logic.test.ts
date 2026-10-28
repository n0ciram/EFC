/**
 * Lógica de la interfaz y de las ventanas que puede probarse sin Electron ni pantalla.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spring } from '../../src/animations/spring';
import { paginate } from '../../src/components/pagination';
import { hitTest, petalPath, polar, wheelGeometry } from '../../src/lib/geometry';
import type { WheelTarget } from '../../src/types/ipc';
import { chooseAnchor, placeToast, placeWheel } from '../../electron/main/placement';
import { MOD_CTRL, MOD_SHIFT, parseAccelerator } from '../../electron/windows/shortcut';

const target = (id: string): WheelTarget => ({ id: id as WheelTarget['id'], label: id.toUpperCase(), description: id, icon: 'photo' });

describe('Colocación de la rueda', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };

  it('se centra en el ancla cuando cabe', () => {
    const p = placeWheel({ x: 800, y: 500 }, 300, 372, work);
    assert.deepEqual(p.window, { x: 614, y: 314, width: 372, height: 372 });
    assert.equal(p.shifted, false);
  });

  it('se recoloca para no salirse de la pantalla (esquina inferior derecha)', () => {
    const p = placeWheel({ x: 1910, y: 1035 }, 300, 372, work);
    assert.equal(p.shifted, true);
    // El círculo visible (radio 150) queda dentro del área de trabajo con 8 px de margen.
    assert.ok(p.center.x + 150 <= 1920 - 8 + 0.5);
    assert.ok(p.center.y + 150 <= 1040 - 8 + 0.5);
  });

  it('respeta monitores con coordenadas negativas (pantalla a la izquierda)', () => {
    const left = { x: -1280, y: 0, width: 1280, height: 984 };
    const p = placeWheel({ x: -1275, y: 10 }, 300, 372, left);
    assert.ok(p.center.x - 150 >= -1280 + 8 - 0.5);
    assert.ok(p.center.y - 150 >= 8 - 0.5);
  });

  it('usa el cursor si está sobre el Explorador; si no, el archivo enfocado o el centro de la ventana', () => {
    const win = { x: 100, y: 100, width: 800, height: 600 };
    assert.equal(chooseAnchor({ x: 300, y: 300 }, win, null).source, 'cursor');
    const item = { x: 200, y: 250, width: 300, height: 24 };
    const viaItem = chooseAnchor({ x: 1500, y: 900 }, win, item);
    assert.equal(viaItem.source, 'item');
    assert.deepEqual(viaItem.point, { x: 350, y: 262 });
    assert.equal(chooseAnchor({ x: 1500, y: 900 }, win, null).source, 'window');
  });

  it('coloca la notificación dentro del área de trabajo', () => {
    const r = placeToast({ x: 10, y: 1030 }, 388, 120, work);
    assert.ok(r.x >= 12 && r.y + r.height <= 1040 - 12);
  });
});

describe('Atajo de teclado', () => {
  it('interpreta el atajo predeterminado', () => {
    const parsed = parseAccelerator('CommandOrControl+Shift+E');
    assert.deepEqual(parsed, { vk: 0x45, mods: MOD_CTRL | MOD_SHIFT, label: 'Ctrl + Mayús + E' });
  });

  it('admite teclas de función y rechaza combinaciones no válidas', () => {
    assert.equal(parseAccelerator('Alt+F9')?.vk, 0x78);
    assert.equal(parseAccelerator('Ctrl+Shift'), null);
    assert.equal(parseAccelerator('Ctrl+E+R'), null);
  });
});

describe('Geometría de la rueda', () => {
  const g = wheelGeometry(300);

  it('asigna cada ángulo al pétalo correcto (incluidos los huecos)', () => {
    const c = 150;
    const at = (angle: number, r = 105) => polar(c, c, r, angle);
    for (let i = 0; i < 8; i++) {
      const p = at(i * 45);
      assert.deepEqual(hitTest(p.x, p.y, c, c, g, 8), { kind: 'sector', index: i });
      const nearBoundary = at(i * 45 + 22);
      assert.deepEqual(hitTest(nearBoundary.x, nearBoundary.y, c, c, g, 8), { kind: 'sector', index: i });
    }
    assert.equal(hitTest(150, 150, c, c, g, 8).kind, 'center');
    assert.equal(hitTest(2, 2, c, c, g, 8).kind, 'outside');
  });

  it('genera trazados SVG válidos para cualquier número de pétalos', () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const step = 360 / n;
      const d = petalPath(150, 150, g, -step / 2, step / 2);
      assert.match(d, /^M [\d.-]+ [\d.-]+/);
      assert.ok(!d.includes('NaN'), `NaN con ${n} pétalos`);
    }
  });

  it('un solo pétalo es un anillo centrado: cada arco une puntos opuestos del mismo círculo', () => {
    const d = petalPath(150, 150, g, -180, 180);
    const points = [...d.matchAll(/[MA] (?:[\d.]+ [\d.]+ 0 [01] [01] )?([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    // Todos los puntos están en la vertical del centro, a la distancia del radio exterior o interior.
    for (const [x, y] of points) {
      assert.equal(x, 150);
      const r = Math.abs((y as number) - 150);
      assert.ok(Math.abs(r - g.petalOuter) < 0.01 || Math.abs(r - g.petalInner) < 0.01, `punto fuera del anillo: ${x},${y}`);
    }
    assert.equal(points.length, 6);
  });
});

describe('Paginación de destinos', () => {
  it('no pagina con 8 o menos y marca el primero como destacado', () => {
    const pages = paginate(Array.from({ length: 8 }, (_, i) => target(`f${i}`)));
    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.length, 8);
    assert.equal(pages[0]?.[0]?.kind === 'target' && pages[0][0].recommended, true);
  });

  it('con más de 8 usa «Más» y «Volver» sin perder ningún destino', () => {
    const targets = Array.from({ length: 11 }, (_, i) => target(`f${i}`));
    const pages = paginate(targets);
    assert.equal(pages.length, 2);
    assert.equal(pages[0]?.at(-1)?.kind, 'more');
    assert.equal(pages[1]?.[0]?.kind, 'back');
    const shown = pages.flat().filter((p) => p.kind === 'target').map((p) => (p.kind === 'target' ? p.target.id : ''));
    assert.deepEqual(shown, targets.map((t) => t.id));
    assert.ok(pages.every((p) => p.length <= 8));
  });
});

describe('Grupos de destinos', () => {
  const tool = (id: string, label: string) => ({ ...target(id), label, group: 'pdf-tools' as const });

  it('las herramientas ocupan un solo pétalo, después de los formatos, que abre su propia página con «Volver»', () => {
    const pages = paginate([target('jpg'), tool('shrink', 'REDUCIR'), tool('pdf-split', 'SEPARAR'), tool('pdf-rotate', 'GIRAR'), target('png'), target('txt')]);
    assert.equal(pages.length, 2);
    const main = pages[0] ?? [];
    assert.deepEqual(main.map((p) => p.kind), ['target', 'target', 'target', 'group']);
    const group = main[3];
    assert.ok(group?.kind === 'group' && group.to === 1 && group.info.description === 'Reducir, separar…');
    const inside = pages[1] ?? [];
    assert.ok(inside[0]?.kind === 'back' && inside[0].to === 0);
    assert.deepEqual(inside.slice(1).map((p) => (p.kind === 'target' ? p.target.id : p.kind)), ['shrink', 'pdf-split', 'pdf-rotate']);
  });

  it('con muchos formatos, el grupo y «Más» conviven y «Volver» del grupo regresa a su página', () => {
    const formats = Array.from({ length: 9 }, (_, i) => target(`f${i}`));
    const pages = paginate([tool('pdf-merge', 'UNIR'), ...formats, tool('shrink', 'REDUCIR')]);
    // Página 0: 6 formatos + grupo + Más (el grupo siempre visible); página 1: Volver + 3 formatos;
    // página 2: el grupo.
    assert.equal(pages.length, 3);
    assert.deepEqual(pages[0]?.map((p) => p.kind), ['target', 'target', 'target', 'target', 'target', 'target', 'group', 'more']);
    const more = pages[0]?.at(-1);
    assert.ok(more?.kind === 'more' && more.to === 1);
    const back1 = pages[1]?.[0];
    assert.ok(back1?.kind === 'back' && back1.to === 0);
    const back = pages[2]?.[0];
    assert.ok(back?.kind === 'back' && back.to === 0);
    const shown = pages.flat().filter((p) => p.kind === 'target').length;
    assert.equal(shown, 11, 'no se pierde ningún destino');
  });
});

describe('Muelles de animación', () => {
  it('genera una curva linear() que termina en 1 con un rebote acotado', () => {
    const curve = spring({ stiffness: 420, damping: 25 });
    assert.match(curve.easing, /^linear\(0, .*, 1\)$/);
    assert.ok(curve.duration > 200 && curve.duration < 1200, `duración ${curve.duration}`);
    assert.ok(curve.peak > 1 && curve.peak < 1.15, `pico ${curve.peak}`);
  });

  it('un muelle sobreamortiguado no rebota', () => {
    assert.ok(spring({ stiffness: 300, damping: 60 }).peak <= 1.001);
  });
});
