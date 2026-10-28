/**
 * Graba la demostración del README: EFC real (en inglés) sobre un escritorio de ejemplo.
 *
 * Se ejecuta dentro de Electron con los mismos ganchos que las pruebas E2E. Dibuja un Explorador de
 * ejemplo en una ventana fuera de pantalla, abre la rueda con archivos reales, mueve un cursor
 * simulado por los pétalos, convierte y va capturando las ventanas de EFC. scripts/demo/record.mjs
 * compone después los fotogramas y crea el GIF.
 */
import { BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { E2EHooks } from '../../electron/main/main';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Point {
  x: number;
  y: number;
}

interface Shot {
  t: number;
  bg: string;
  cursor: Point;
  windows: { file: string; x: number; y: number; width: number; height: number }[];
}

/** Filas del Explorador de ejemplo; las marcadas con `real` existen de verdad en la carpeta. */
const BASE_FILES: [string, string, string, string][] = [
  ['beach.png', '#3f8ad8', 'PNG File', '2.4 MB'],
  ['budget.xlsx', '#2f8a4c', 'Microsoft Excel Worksheet', '48 KB'],
  ['interview.wav', '#b0447e', 'WAV File', '31.2 MB'],
  ['logo.svg', '#d4a32a', 'SVG Document', '12 KB'],
  ['meeting notes.txt', '#777777', 'Text Document', '3 KB'],
  ['product demo.mp4', '#7a4fc4', 'MP4 Video', '84.6 MB'],
  ['quarterly report.pdf', '#d9473b', 'PDF Document', '15.7 MB'],
  ['team photo.jpg', '#4ca66b', 'JPG File', '3.1 MB'],
];

const STATES: Record<string, { extra: [string, string, string, string][]; selected: string }> = {
  A: { extra: [], selected: 'beach.png' },
  B: { extra: [['beach.webp', '#3f8ad8', 'WEBP File', '0.4 MB']], selected: 'beach.png' },
  C: { extra: [['beach.webp', '#3f8ad8', 'WEBP File', '0.4 MB']], selected: 'quarterly report.pdf' },
  D: {
    extra: [
      ['beach.webp', '#3f8ad8', 'WEBP File', '0.4 MB'],
      ['quarterly report_shrunk.pdf', '#d9473b', 'PDF Document', '1.2 MB'],
    ],
    selected: 'quarterly report.pdf',
  },
};

/** Posición del Explorador de ejemplo dentro de la zona grabada. */
const WIN = { dx: 70, dy: 50, width: 1140, height: 620 };
const ROW = { top: 150, height: 34 };

function rows(state: string): [string, string, string, string][] {
  return [...BASE_FILES, ...STATES[state]!.extra].sort((a, b) => a[0].localeCompare(b[0]));
}

function desktopHtml(state: string, W: number, H: number, region: { x: number; y: number }): string {
  const x0 = region.x + WIN.dx;
  const y0 = region.y + WIN.dy;
  const list = rows(state)
    .map(([name, color, type, size], i) => {
      const top = ROW.top + i * ROW.height;
      // Cada archivo conserva su fecha aunque aparezcan otros en la lista.
      const minute = 10 + (BASE_FILES.findIndex((f) => f[0] === name) + 1 || 40 + i);
      const selected = name === STATES[state]!.selected;
      return `<div class="row${selected ? ' sel' : ''}" style="top:${top}px"><span class="ico" style="background:${color}"></span><span class="n">${name}</span><span class="d">10/24/2026 9:${minute} AM</span><span class="ty">${type}</span><span class="s">${size}</span></div>`;
    })
    .join('');
  const nav = ['Home', 'Gallery', 'Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos']
    .map((n, i) => `<div class="nav${n === 'Documents' ? ' on' : ''}" style="top:${110 + i * 34}px">${n}</div>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:'Segoe UI Variable Text','Segoe UI',sans-serif}
    body{background:radial-gradient(120% 90% at 20% 10%,#7fb2ff 0%,#2f5fd0 45%,#1a2a6b 100%)}
    .win{position:absolute;left:${x0}px;top:${y0}px;width:${WIN.width}px;height:${WIN.height}px;background:#fff;border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.35);overflow:hidden}
    .bar{position:absolute;left:0;right:0;top:0;height:92px;background:#f3f3f3;border-bottom:1px solid #e5e5e5}
    .tab{position:absolute;left:12px;top:8px;height:32px;width:220px;background:#fff;border-radius:8px 8px 0 0;font-size:12px;line-height:32px;padding-left:14px;color:#1a1a1a}
    .addr{position:absolute;left:120px;top:52px;right:260px;height:30px;background:#fff;border:1px solid #e1e1e1;border-radius:6px;font-size:12.5px;line-height:30px;padding-left:12px;color:#1a1a1a}
    .search{position:absolute;right:16px;top:52px;width:220px;height:30px;background:#fff;border:1px solid #e1e1e1;border-radius:6px;font-size:12.5px;line-height:30px;padding-left:12px;color:#888}
    .side{position:absolute;left:0;top:92px;bottom:0;width:190px;background:#f7f7f7}
    .nav{position:absolute;left:14px;width:160px;height:28px;line-height:28px;padding-left:12px;font-size:12.5px;color:#1a1a1a;border-radius:5px}
    .nav.on{background:#e5e5e5}
    .head{position:absolute;left:200px;right:0;top:${ROW.top - 34}px;height:28px;font-size:12px;color:#6b6b6b}
    .row{position:absolute;left:200px;right:14px;height:${ROW.height - 4}px;font-size:12.5px;color:#1a1a1a;border-radius:5px}
    .row.sel{background:#cce4f7}
    .ico{position:absolute;left:12px;top:6px;width:16px;height:19px;border-radius:3px}
    .n{position:absolute;left:40px;line-height:${ROW.height - 4}px}
    .d,.ty,.s{position:absolute;line-height:${ROW.height - 4}px;color:#6b6b6b}
    .d{left:400px}.ty{left:600px}.s{left:830px}
    .head span{position:absolute;line-height:28px}
  </style></head><body>
    <div class="win">
      <div class="bar"><div class="tab">Documents</div><div class="addr">This PC  ›  Documents  ›  Demo</div><div class="search">Search Demo</div></div>
      <div class="side">${nav}</div>
      <div class="head"><span style="left:40px">Name</span><span style="left:400px">Date modified</span><span style="left:600px">Type</span><span style="left:830px">Size</span></div>
      ${list}
    </div>
  </body></html>`;
}

async function renderDesktop(html: string, W: number, H: number, file: string): Promise<void> {
  const win = new BrowserWindow({ show: false, width: W, height: H, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await sleep(400);
  const image = await win.webContents.capturePage();
  writeFileSync(file, image.resize({ width: W, height: H }).toPNG());
  win.destroy();
}

async function js<T>(win: BrowserWindow, code: string): Promise<T> {
  return (await win.webContents.executeJavaScript(code, true)) as T;
}

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    await sleep(40);
  }
  throw new Error('Tiempo agotado');
}

export async function run(hooks: E2EHooks): Promise<void> {
  const dir = process.env.EFC_E2E_DIR as string;
  const out = process.env.EFC_E2E_OUT as string;
  const framesDir = path.join(out, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const display = screen.getPrimaryDisplay();
  const { width: W, height: H } = display.bounds;
  const regionSize = { width: Math.min(1280, W), height: Math.min(720, H) };
  const region = { x: display.bounds.x + Math.round((W - regionSize.width) / 2), y: display.bounds.y + Math.round((H - regionSize.height) / 2), ...regionSize };

  // Escritorios de ejemplo (uno por estado de la carpeta).
  const backgrounds: Record<string, string> = {};
  for (const state of Object.keys(STATES)) {
    backgrounds[state] = path.join(out, `desktop-${state}.png`);
    await renderDesktop(desktopHtml(state, W, H, { x: region.x - display.bounds.x, y: region.y - display.bounds.y }), W, H, backgrounds[state]);
  }
  const rowCenter = (state: string, name: string): Point => {
    const i = rows(state).findIndex((r) => r[0] === name);
    return { x: region.x + WIN.dx + 200 + 300, y: region.y + WIN.dy + ROW.top + i * ROW.height + (ROW.height - 4) / 2 };
  };

  let bg = 'A';
  const setBg = (state: string): void => {
    bg = state;
    hooks.useStaticBackdrop(backgrounds[state] as string);
  };
  setBg('A');

  // Grabación continua de las ventanas visibles de EFC.
  const shots: Shot[] = [];
  let cursor: Point = { x: region.x + region.width * 0.62, y: region.y + region.height * 0.75 };
  let recording = true;
  const t0 = Date.now();
  let n = 0;
  const loop = (async () => {
    while (recording) {
      const shot: Shot = { t: Date.now() - t0, bg, cursor: { ...cursor }, windows: [] };
      for (const win of [hooks.wheelWindow(), hooks.toastWindow()]) {
        if (!win || win.isDestroyed() || !win.isVisible()) continue;
        const image = await win.webContents.capturePage();
        if (image.isEmpty()) continue;
        const b = win.getBounds();
        const file = `w${n}-${win.id}.png`;
        writeFileSync(path.join(framesDir, file), image.toPNG());
        shot.windows.push({ file, x: b.x, y: b.y, width: b.width, height: b.height });
      }
      shots.push(shot);
      n++;
      await sleep(shot.windows.length > 0 ? 10 : 50);
    }
  })();

  /** Desliza el cursor simulado hasta `to` (coordenadas de pantalla) y se lo cuenta a la rueda. */
  const glide = async (to: Point, ms: number, win: BrowserWindow | null = null): Promise<void> => {
    const from = { ...cursor };
    const steps = Math.max(1, Math.round(ms / 25));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      cursor = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      if (win && win.isVisible()) {
        const b = win.getBounds();
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(cursor.x - b.x), y: Math.round(cursor.y - b.y) });
      }
      await sleep(25);
    }
  };
  const clickAt = async (win: BrowserWindow): Promise<void> => {
    const b = win.getBounds();
    const p = { x: Math.round(cursor.x - b.x), y: Math.round(cursor.y - b.y) };
    win.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 });
    await sleep(90);
    win.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
  };
  /** Centro de un pétalo en coordenadas de pantalla. */
  const petal = async (wheel: BrowserWindow, selector: string): Promise<Point> => {
    const b = wheel.getBounds();
    const p = await js<Point>(
      wheel,
      `(() => { const el = ${selector}; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    return { x: b.x + p.x, y: b.y + p.y };
  };
  const byLabel = (label: string): string => `[...document.querySelectorAll('.petal')].find((p) => p.querySelector('.petal-text')?.textContent === ${JSON.stringify(label)}).querySelector('.petal-label')`;
  const openWheel = async (file: string, at: Point): Promise<BrowserWindow> => {
    await hooks.openForPaths([path.join(dir, file)], at);
    const wheel = await waitFor(() => {
      const w = hooks.wheelWindow();
      return w?.isVisible() ? w : null;
    });
    await waitFor(async () => (await js<string | null>(wheel, `document.querySelector('.wheel')?.dataset.mode ?? null`)) === 'open');
    return wheel;
  };
  const toastTitle = async (title: string): Promise<void> => {
    await waitFor(async () => {
      const t = hooks.toastWindow();
      if (!t || !t.isVisible()) return false;
      return js<boolean>(t, `[...document.querySelectorAll('.toast-title')].some((e) => e.textContent === ${JSON.stringify(title)})`);
    }, 30_000);
  };

  // 1. Foto: la rueda, un vistazo a los formatos y conversión a WEBP.
  await sleep(900);
  await glide(rowCenter('A', 'beach.png'), 700);
  await sleep(350);
  let wheel = await openWheel('beach.png', cursor);
  await sleep(500);
  for (const label of ['JPG', 'WEBP', 'PDF', 'WEBP']) {
    await glide(await petal(wheel, byLabel(label)), 380, wheel);
    await sleep(label === 'WEBP' ? 550 : 420);
  }
  await clickAt(wheel);
  await glide({ x: cursor.x + 150, y: cursor.y - 90 }, 400);
  await toastTitle('Saved');
  setBg('B');
  await sleep(1700);

  // 2. PDF: herramientas → SHRINK.
  await glide(rowCenter('C', 'quarterly report.pdf'), 800);
  setBg('C');
  await sleep(350);
  wheel = await openWheel('quarterly report.pdf', cursor);
  await sleep(500);
  await glide(await petal(wheel, `document.querySelector('.petal[data-kind="group"] .petal-label')`), 450, wheel);
  await sleep(600);
  await clickAt(wheel);
  await sleep(700);
  for (const label of ['SPLIT', 'ROTATE', 'SHRINK']) {
    await glide(await petal(wheel, byLabel(label)), 380, wheel);
    await sleep(label === 'SHRINK' ? 600 : 420);
  }
  await clickAt(wheel);
  await glide({ x: cursor.x + 170, y: cursor.y + 110 }, 400);
  await toastTitle('Saved');
  setBg('D');
  await sleep(2200);

  recording = false;
  await loop;
  writeFileSync(path.join(out, 'shots.json'), JSON.stringify({ region, display: display.bounds, backgrounds, shots }, null, 1));
  hooks.quit();
}
