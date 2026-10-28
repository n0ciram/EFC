/**
 * Controlador de las pruebas de extremo a extremo. Se ejecuta DENTRO del proceso principal de Electron
 * (solo en desarrollo: `EFC_E2E_DRIVER`) y maneja la aplicación real: ventanas transparentes, interfaz
 * React, IPC, cola de trabajos, proceso de conversión y avisos. Lo único que sustituye es la consulta
 * al Explorador (que solo existe en Windows): abre la rueda directamente con archivos de prueba.
 *
 * Las acciones se hacen con eventos de ratón y teclado reales sobre las ventanas, y los resultados se
 * comprueban leyendo los archivos generados en disco.
 */
import { screen, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import type { E2EHooks } from '../../electron/main/main';

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
}

const PETAL_RADIUS = 150 * ((0.455 + 0.947) / 2);
/** Centro de la ventana de la rueda (se fija al arrancar con el tamaño real). */
let CENTER = 186;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 10_000, every = 40): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (err) {
      last = err;
    }
    await sleep(every);
  }
  throw new Error(`Tiempo agotado esperando: ${what}${last ? ` (${String(last)})` : ''}`);
}

function petalPoint(index: number, count: number): { x: number; y: number } {
  const angle = ((360 / count) * index * Math.PI) / 180;
  return { x: Math.round(CENTER + PETAL_RADIUS * Math.sin(angle)), y: Math.round(CENTER - PETAL_RADIUS * Math.cos(angle)) };
}

async function js<T>(win: BrowserWindow, code: string): Promise<T> {
  return (await win.webContents.executeJavaScript(code, true)) as T;
}

async function wheelMode(win: BrowserWindow): Promise<string | null> {
  return js<string | null>(win, `document.querySelector('.wheel')?.dataset.mode ?? null`);
}

async function petalLabels(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(win, `[...document.querySelectorAll('.petal .petal-text')].map((e) => e.textContent)`);
}

function move(win: BrowserWindow, x: number, y: number): void {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
}

async function click(win: BrowserWindow, x: number, y: number): Promise<void> {
  move(win, x, y);
  await sleep(30);
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(30);
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

function key(win: BrowserWindow, keyCode: string): void {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}

export async function run(hooks: E2EHooks): Promise<void> {
  const dir = process.env.EFC_E2E_DIR as string;
  const out = process.env.EFC_E2E_OUT as string;
  mkdirSync(out, { recursive: true });
  const results: StepResult[] = [];
  const fixture = (name: string): string => path.join(dir, name);

  /** Capturas de cada ventana y su posición, para componerlas después sobre el fondo de escritorio. */
  const placements: { name: string; x: number; y: number }[] = [];
  const shot = async (win: BrowserWindow | null, name: string): Promise<void> => {
    if (!win) return;
    const image = await win.webContents.capturePage();
    writeFileSync(path.join(out, `${name}.png`), image.toPNG());
    const bounds = win.getBounds();
    placements.push({ name, x: bounds.x, y: bounds.y });
    writeFileSync(path.join(out, 'placements.json'), JSON.stringify(placements, null, 2));
  };

  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, ms: Date.now() - started, detail });
      console.log(`[e2e] ✔ ${name}`);
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - started, detail: (err as Error).stack ?? String(err) });
      console.log(`[e2e] ✖ ${name}: ${(err as Error).message}`);
      // Deja la rueda cerrada para el siguiente paso.
      const w = hooks.wheelWindow();
      if (w?.isVisible()) {
        key(w, 'Escape');
        await sleep(400);
      }
    }
  };

  CENTER = hooks.wheelWindowSize() / 2;
  const wheel = await waitFor('ventana de la rueda cargada', () => {
    const w = hooks.wheelWindow();
    return w && !w.webContents.isLoading() ? w : null;
  }, 20_000);
  await waitFor('FFmpeg localizado', () => hooks.caps().ffmpeg !== null, 15_000).catch(() => undefined);

  /** Abre la rueda para unos archivos y espera a que la animación de apertura empiece. */
  const open = async (files: string[]): Promise<string[]> => {
    const shown = await hooks.openForPaths(files.map(fixture), { x: 700, y: 420 });
    if (!shown) throw new Error('La rueda no se abrió');
    await waitFor('rueda visible', () => wheel.isVisible());
    await waitFor('rueda en modo abierto', async () => (await wheelMode(wheel)) === 'open');
    await sleep(700); // fin de la animación de apertura
    return petalLabels(wheel);
  };

  const closed = (): Promise<boolean> => waitFor('rueda oculta', () => !wheel.isVisible(), 3000);

  const choose = async (label: string): Promise<void> => {
    const labels = await petalLabels(wheel);
    const index = labels.indexOf(label);
    if (index < 0) throw new Error(`No hay pétalo «${label}» (hay: ${labels.join(', ')})`);
    const p = petalPoint(index, labels.length);
    move(wheel, p.x, p.y);
    await sleep(350);
    const mode = await wheelMode(wheel);
    if (mode !== 'open') throw new Error(`La rueda no está abierta antes del clic (modo ${mode}, visible ${wheel.isVisible()})`);
    await click(wheel, p.x, p.y);
    await waitFor('rueda cerrándose tras el clic', async () => (await wheelMode(wheel)) !== 'open', 3000);
  };

  const toastState = async (): Promise<{ status: string; title: string; detail: string }[]> => {
    const t = hooks.toastWindow();
    if (!t || !t.isVisible()) return [];
    return js(t, `[...document.querySelectorAll('.toast-card')].map((c) => ({ status: c.dataset.status, title: c.querySelector('.toast-title')?.textContent ?? '', detail: c.querySelector('.toast-detail')?.textContent ?? '' }))`);
  };

  const toastMeta = async (): Promise<string[]> => {
    const t = hooks.toastWindow();
    if (!t || !t.isVisible()) return [];
    return js(t, `[...document.querySelectorAll('.toast-meta')].map((m) => m.textContent ?? '')`);
  };

  const expectFile = async (name: string, magic?: number[]): Promise<string> => {
    const file = fixture(name);
    await waitFor(`archivo ${name}`, () => existsSync(file) && statSync(file).size > 0, 60_000, 100);
    if (magic) {
      const head = readFileSync(file).subarray(0, magic.length);
      if (!magic.every((b, i) => head[i] === b)) throw new Error(`${name}: cabecera inesperada ${head.toString('hex')}`);
    }
    return `${name} (${statSync(file).size} bytes)`;
  };

  await step('PNG: la rueda muestra los formatos de imagen compatibles', async () => {
    const labels = await open(['foto de prueba.png']);
    await shot(wheel, '01-rueda-png');
    // 9 destinos: los 7 primeros y «Más» (BMP y GIF quedan en la segunda página).
    const expected = ['JPG', 'WEBP', 'PDF', 'ICO', 'AVIF', 'TIFF', 'Herramientas', 'Más'];
    if (labels.join(',') !== expected.join(',')) throw new Error(`Pétalos: ${labels.join(', ')}`);
    const glass = await js<boolean>(wheel, `!!document.querySelector('.wheel img')`);
    if (!glass) throw new Error('La rueda no recibió la captura real del escritorio');
    // A partir de aquí, el escritorio es una imagen fija: en Linux (sin compositor) las ventanas de
    // EFC aparecerían en negro en las capturas, algo que en Windows evita la exclusión de capturas.
    const wallpaper = process.env.EFC_E2E_WALLPAPER;
    if (wallpaper) hooks.useStaticBackdrop(wallpaper);
    return labels;
  });

  await step('Pasar el cursor sobre un pétalo lo resalta y la esfera muestra el destino', async () => {
    const p = petalPoint(2, 8);
    move(wheel, p.x, p.y);
    await sleep(450);
    await shot(wheel, '02-rueda-hover');
    const active = await js<string | null>(wheel, `document.querySelector('.petal[data-active="true"] .petal-text')?.textContent ?? null`);
    const orb = await js<string>(wheel, `document.querySelector('.orb-target-label')?.textContent ?? ''`);
    if (active !== 'PDF' || orb !== 'PDF') throw new Error(`activo=${active} esfera=${orb}`);
    return { active, orb };
  });

  await step('Escape cierra la rueda sin dejar la ventana visible', async () => {
    key(wheel, 'Escape');
    await closed();
    return 'oculta';
  });

  await step('Un clic fuera del círculo cierra la rueda', async () => {
    await open(['foto de prueba.png']);
    await click(wheel, 6, 6);
    await closed();
    return 'oculta';
  });

  await step('PNG → JPG: clic en el pétalo, conversión real y aviso de guardado', async () => {
    await open(['foto de prueba.png']);
    await choose('JPG');
    await closed();
    const t = await waitFor('aviso visible', () => hooks.toastWindow()?.isVisible() ?? false, 4000);
    const file = await expectFile('foto de prueba.jpg', [0xff, 0xd8, 0xff]);
    const toast = await waitFor('aviso «Guardado»', async () => (await toastState()).find((c) => c.status === 'done'), 15_000);
    await shot(hooks.toastWindow(), '03-aviso-guardado');
    return { t, file, toast };
  });

  await step('Si el destino ya existe se usa «_converted» y no se sobrescribe', async () => {
    const before = readFileSync(fixture('foto de prueba.jpg'));
    await open(['foto de prueba.png']);
    await choose('JPG');
    const file = await expectFile('foto de prueba_converted.jpg', [0xff, 0xd8, 0xff]);
    if (!readFileSync(fixture('foto de prueba.jpg')).equals(before)) throw new Error('Se modificó el archivo existente');
    return file;
  });

  await step('Nombre largo con espacios y acentos: se abrevia sin deformar la esfera y se convierte', async () => {
    const name = 'Fotografía del almacén — revisión final (copia número 2) ñandú.png';
    await open([name]);
    await shot(wheel, '04-rueda-nombre-largo');
    const lines = await js<string[]>(wheel, `[...document.querySelectorAll('.orb-name-line')].map((e) => e.textContent)`);
    const orb = await js<{ w: number; h: number }>(wheel, `(() => { const r = document.querySelector('.orb').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    if (Math.abs(orb.w - orb.h) > 1) throw new Error(`La esfera no es circular: ${orb.w}×${orb.h}`);
    await choose('WEBP');
    const file = await expectFile(name.replace(/\.png$/, '.webp'), [0x52, 0x49, 0x46, 0x46]);
    return { lines, orb, file };
  });

  await step('PDF de 3 páginas → JPG: carpeta con exactamente 3 imágenes', async () => {
    const labels = await open(['informe trimestral.pdf']);
    await shot(wheel, '05-rueda-pdf');
    if (labels.join(',') !== 'JPG,PNG,TXT,WEBP,TIFF,PDF') throw new Error(`Pétalos: ${labels.join(', ')}`);
    await choose('JPG');
    const folder = fixture('informe trimestral (JPG)');
    await waitFor('carpeta de páginas', () => existsSync(folder) && readdirSync(folder).length === 3, 60_000, 100);
    const pages = readdirSync(folder).sort();
    if (pages.join('|') !== 'informe trimestral-01.jpg|informe trimestral-02.jpg|informe trimestral-03.jpg') throw new Error(pages.join(', '));
    await waitFor('aviso de carpeta guardada', async () => (await toastState()).find((c) => c.status === 'done' && /3 páginas/.test(c.detail)), 15_000);
    await shot(hooks.toastWindow(), '06-aviso-pdf');
    return pages;
  });

  /** Abre el pétalo «Herramientas PDF» y devuelve los pétalos de dentro. */
  const enterTools = async (): Promise<string[]> => {
    const index = await js<number>(wheel, `[...document.querySelectorAll('.petal')].findIndex((p) => p.dataset.kind === 'group')`);
    if (index < 0) throw new Error('No hay pétalo de herramientas');
    const count = (await petalLabels(wheel)).length;
    const p = petalPoint(index, count);
    move(wheel, p.x, p.y);
    await sleep(300);
    await click(wheel, p.x, p.y);
    await waitFor('página de herramientas', async () => (await petalLabels(wheel))[0] === 'Volver', 3000);
    await sleep(700); // fin de la animación de cambio de página
    return petalLabels(wheel);
  };

  const pdfPages = async (name: string): Promise<number[]> => {
    const doc = await PDFDocument.load(readFileSync(fixture(name)));
    return doc.getPages().map((p) => p.getRotation().angle);
  };

  await step('PDF → SEPARAR: carpeta «(páginas)» con un PDF por página', async () => {
    await open(['informe trimestral.pdf']);
    const tools = await enterTools();
    await shot(wheel, '15-herramientas-pdf');
    if (tools.join(',') !== 'Volver,REDUCIR,SEPARAR,GIRAR') throw new Error(`Herramientas: ${tools.join(', ')}`);
    await choose('SEPARAR');
    const folder = fixture('informe trimestral (páginas)');
    await waitFor('carpeta de páginas PDF', () => existsSync(folder) && readdirSync(folder).length === 3, 30_000, 100);
    const files = readdirSync(folder).sort();
    for (const f of files) {
      const doc = await PDFDocument.load(readFileSync(path.join(folder, f)));
      if (doc.getPageCount() !== 1) throw new Error(`${f}: ${doc.getPageCount()} páginas`);
    }
    return files;
  });

  await step('Varios PDF → Herramientas PDF → UNIR, y GIRAR', async () => {
    const labels = await open(['informe trimestral.pdf', 'anexo.pdf']);
    await shot(wheel, '14-rueda-varios-pdf');
    if (labels.at(-1) !== 'PDF') throw new Error(`Pétalos: ${labels.join(', ')}`);
    const tools = await enterTools();
    if (tools.join(',') !== 'Volver,UNIR,REDUCIR,SEPARAR,GIRAR') throw new Error(`Herramientas: ${tools.join(', ')}`);
    await choose('UNIR');
    await expectFile('anexo_combinado.pdf', [0x25, 0x50, 0x44, 0x46]);
    const merged = await pdfPages('anexo_combinado.pdf');
    if (merged.length !== 4) throw new Error(`Páginas unidas: ${merged.length}`);
    await open(['anexo.pdf']);
    await enterTools();
    await choose('GIRAR');
    await expectFile('anexo_girado.pdf', [0x25, 0x50, 0x44, 0x46]);
    const turned = await pdfPages('anexo_girado.pdf');
    if (turned.join(',') !== '90') throw new Error(`Giro: ${turned.join(',')}`);
    return { merged: merged.length, turned };
  });

  await step('Varias imágenes: la rueda ofrece «UNIR» y crea un único PDF', async () => {
    const labels = await open(['foto de prueba.png', 'segunda imagen.png']);
    await shot(wheel, '07-rueda-multiple');
    if (labels.at(-2) !== 'Herramientas') throw new Error(`Pétalos: ${labels.join(', ')}`);
    const tools = await enterTools();
    if (tools.join(',') !== 'Volver,UNIR,REDUCIR') throw new Error(`Herramientas: ${tools.join(', ')}`);
    await choose('UNIR');
    return expectFile('foto de prueba_combinado.pdf', [0x25, 0x50, 0x44, 0x46]);
  });

  await step('Un archivo dañado produce un aviso de error con «Reintentar» y ningún archivo', async () => {
    await open(['dañado.png']);
    await choose('JPG');
    const card = await waitFor('aviso de error', async () => (await toastState()).find((c) => c.status === 'error'), 20_000);
    await shot(hooks.toastWindow(), '08-aviso-error');
    const retry = await js<boolean>(hooks.toastWindow() as BrowserWindow, `!!document.querySelector('.toast-card[data-status="error"] .toast-button')`);
    if (!retry) throw new Error('Sin botón de reintento');
    if (existsSync(fixture('dañado.jpg'))) throw new Error('Se generó un archivo a partir de un original dañado');
    const leftovers = readdirSync(dir).filter((n) => n.startsWith('.~efc-'));
    if (leftovers.length > 0) throw new Error(`Temporales sin borrar: ${leftovers.join(', ')}`);
    return card;
  });

  await step('«Más» abre la segunda página y «Volver» regresa', async () => {
    await open(['foto de prueba.png']);
    const more = await petalLabels(wheel);
    const p = petalPoint(more.indexOf('Más'), more.length);
    await click(wheel, p.x, p.y);
    await waitFor('segunda página', async () => (await petalLabels(wheel)).join(',') === 'Volver,BMP,GIF', 3000);
    await sleep(700); // fin de la animación de cambio de página
    const back = petalPoint(0, 3);
    move(wheel, back.x, back.y);
    await sleep(300);
    await click(wheel, back.x, back.y);
    await waitFor('primera página', async () => (await petalLabels(wheel)).includes('Herramientas'), 3000);
    key(wheel, 'Escape');
    await closed();
    return 'Volver,BMP,GIF';
  });

  await step('REDUCIR una foto de 12 MP: archivo «_reducido» de 1920 px y aviso con el ahorro', async () => {
    const labels = await open(['foto grande.jpg']);
    await shot(wheel, '12-rueda-jpg-reducir');
    if (labels.includes('REDUCIR')) throw new Error(`REDUCIR no debe estar en la rueda principal: ${labels.join(', ')}`);
    const tools = await enterTools();
    await shot(wheel, '16-herramientas-imagen');
    if (tools.join(',') !== 'Volver,REDUCIR') throw new Error(`Herramientas: ${tools.join(', ')}`);
    await choose('REDUCIR');
    const file = await expectFile('foto grande_reducido.jpg', [0xff, 0xd8, 0xff]);
    const card = await waitFor('aviso con el ahorro', async () => (await toastMeta()).find((m) => /→.*−\d+/.test(m)), 15_000);
    await shot(hooks.toastWindow(), '13-aviso-reducido');
    const original = statSync(fixture('foto grande.jpg')).size;
    const reduced = statSync(fixture('foto grande_reducido.jpg')).size;
    if (reduced >= original / 2) throw new Error(`No se redujo lo suficiente: ${original} → ${reduced}`);
    return { file, card };
  });

  await step('Menú contextual: dos lanzadores a la vez abren una sola rueda con los dos archivos', async () => {
    // En Windows, una tubería con nombre propia de la prueba; en Linux, un socket local.
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\efc-e2e-menu-${process.pid}` : path.join(os.tmpdir(), `efc-e2e-menu-${process.pid}.sock`);
    if (!(await hooks.startMenuServer(socket))) throw new Error('No arrancó el servidor del menú');
    const send = (name: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const c = net.connect(socket, () => c.end(`${JSON.stringify({ v: 1, paths: [fixture(name)], x: 0, y: 0 })}\n`));
        c.on('close', () => resolve());
        c.on('error', reject);
      });
    await Promise.all([send('foto de prueba.png'), send('segunda imagen.png')]);
    await waitFor('rueda abierta desde el menú', async () => wheel.isVisible() && (await wheelMode(wheel)) === 'open', 5000);
    await sleep(700);
    const title = await js<string>(wheel, `[...document.querySelectorAll('.orb-name-line')].map((e) => e.textContent).join(' ')`);
    await shot(wheel, '17-rueda-desde-menu');
    key(wheel, 'Escape');
    await closed();
    if (!/2 archivos/.test(title)) throw new Error(`Esfera: ${title}`);
    return title;
  });

  await step('Word → PDF con Office: la rueda ofrece solo PDF, avisa «con Word» y crea el PDF', async () => {
    if (!hooks.caps().office?.word) return 'omitido: este equipo no tiene Word';
    const labels = await open(['informe de Word.docx']);
    await shot(wheel, '18-rueda-word');
    if (labels.join(',') !== 'PDF') throw new Error(`Pétalos: ${labels.join(', ')}`);
    // Un solo destino = anillo completo: al resaltarlo debe seguir centrado en el disco.
    const lift = await js<string>(wheel, `(() => { const s = document.querySelector('.petal').style; return s.getPropertyValue('--lift-x') + ' ' + s.getPropertyValue('--lift-y'); })()`);
    if (lift !== '0.00px 0.00px') throw new Error(`El anillo único se desplaza: ${lift}`);
    await choose('PDF');
    const running = await waitFor('aviso «con Word»', async () => (await toastState()).find((t) => t.title === 'Convirtiendo a PDF con Word'), 10_000);
    await shot(hooks.toastWindow(), '19-aviso-word');
    const pdf = await expectFile('informe de Word.pdf', [0x25, 0x50, 0x44, 0x46]);
    return { labels, running: running.title, pdf };
  });

  await step('TXT: la rueda ofrece PDF y Word, y crea un PDF real', async () => {
    const labels = await open(['notas del pedido.txt']);
    await shot(wheel, '11-rueda-texto');
    if (labels.join(',') !== 'PDF,DOCX') throw new Error(`Pétalos: ${labels.join(', ')}`);
    await choose('PDF');
    const pdf = await expectFile('notas del pedido.pdf', [0x25, 0x50, 0x44, 0x46]);
    await open(['notas del pedido.txt']);
    await choose('DOCX');
    const docx = await expectFile('notas del pedido.docx', [0x50, 0x4b, 0x03, 0x04]);
    return { labels, pdf, docx };
  });

  if (hooks.caps().ffmpeg) {
    await step('REDUCIR un vídeo Full HD: MP4 ligero', async () => {
      const labels = await open(['vídeo full hd.mp4']);
      if (labels[0] !== 'REDUCIR') throw new Error(`Pétalos: ${labels.join(', ')}`);
      await choose('REDUCIR');
      const file = await expectFile('vídeo full hd_reducido.mp4');
      const original = statSync(fixture('vídeo full hd.mp4')).size;
      const reduced = statSync(fixture('vídeo full hd_reducido.mp4')).size;
      if (reduced >= original / 2) throw new Error(`No se redujo lo suficiente: ${original} → ${reduced}`);
      return file;
    });

    await step('WAV → MP3 con FFmpeg y progreso real', async () => {
      const labels = await open(['grabación.wav']);
      await shot(wheel, '09-rueda-audio');
      await choose('MP3');
      return { labels, file: await expectFile('grabación.mp3') };
    });

    await step('Cancelar una conversión larga detiene el trabajo y no deja archivos', async () => {
      await open(['vídeo largo.mp4']);
      await choose('WEBM');
      const toastWin = await waitFor('aviso en curso', async () => ((await toastState()).some((c) => c.status === 'running') ? hooks.toastWindow() : null), 8000);
      await sleep(900);
      await shot(toastWin, '10-aviso-progreso');
      const progress = await js<string | null>(toastWin, `document.querySelector('.toast-card[data-status="running"] .toast-progress')?.getAttribute('aria-valuenow') ?? null`);
      const meta = await js<string | null>(toastWin, `document.querySelector('.toast-card[data-status="running"] .toast-meta')?.textContent ?? null`);
      if (!meta || !/^0 de 1 procesados/.test(meta)) throw new Error(`Sin «N de M procesados» en el aviso: ${meta}`);
      const box = await js<{ x: number; y: number }>(toastWin, `(() => { const r = document.querySelector('.toast-card[data-status="running"] .toast-close').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      await click(toastWin, box.x, box.y);
      await waitFor('aviso cancelado', async () => (await toastState()).find((c) => c.status === 'cancelled'), 10_000);
      await sleep(500);
      const leftovers = readdirSync(dir).filter((n) => n.startsWith('.~efc-') || n === 'vídeo largo.webm');
      if (leftovers.length > 0) throw new Error(`Quedaron archivos: ${leftovers.join(', ')}`);
      return { progress, meta };
    });
  }

  await step('Ajustes: el panel se abre junto a la bandeja, aplica los cambios al momento y se cierra con Esc', async () => {
    const display = screen.getPrimaryDisplay().workArea;
    // Como si el icono estuviera en la barra de tareas, abajo a la derecha.
    await hooks.openSettings({ x: display.x + display.width - 120, y: display.y + display.height + 20 });
    const win = await waitFor('panel visible', () => {
      const w = hooks.settingsWindow();
      return w?.isVisible() ? w : null;
    });
    await sleep(600);
    await shot(win, '20-ajustes');
    const bounds = win.getBounds();
    if (bounds.y + bounds.height > display.y + display.height || bounds.x + bounds.width > display.x + display.width) {
      throw new Error(`El panel se sale del área de trabajo: ${JSON.stringify(bounds)}`);
    }
    const scrolls = await js<boolean>(win, `(() => { const c = document.querySelector('.settings-content'); return c.scrollHeight > c.clientHeight + 1; })()`);
    if (scrolls && bounds.height < display.height) throw new Error('El panel no se ajusta a su contenido (tiene barra de desplazamiento)');
    const center = async (selector: string): Promise<{ x: number; y: number }> =>
      js(win, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    const press = async (selector: string): Promise<void> => {
      const p = await center(selector);
      await click(win, p.x, p.y);
    };

    // Interruptor, control segmentado y deslizador: cada cambio queda guardado.
    await press('[aria-label="Desenfocar el fondo"]');
    await waitFor('desenfoque desactivado', () => hooks.config().backdropBlur === false, 3000);
    await press('[aria-label="Calidad de imagen"] .settings-segment:nth-child(1)');
    await waitFor('calidad máxima', () => hooks.config().conversion.jpegQuality === 95, 3000);
    await press('[aria-label="Tamaño al reducir vídeos"] .settings-segment:nth-child(3)');
    await waitFor('vídeo a 1080p', () => hooks.config().conversion.shrinkVideoMaxSide === 1920, 3000);
    const slider = await js<{ x: number; y: number; w: number }>(win, `(() => { const r = document.querySelector('.settings-slider input').getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width }; })()`);
    await click(win, Math.round(slider.x + slider.w - 3), Math.round(slider.y));
    await waitFor('rueda más transparente', () => hooks.config().wheelTransparency === 100, 3000);

    // Atajo: una tecla sin Ctrl/Alt/Win se rechaza; Ctrl + Mayús + K se acepta.
    await press('.settings-keycap');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K' });
    const error = await waitFor('aviso de atajo no válido', () => js<string | null>(win, `document.querySelector('.settings-error')?.textContent ?? null`), 3000);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control', 'shift'] });
    await waitFor('atajo cambiado', () => hooks.config().shortcut === 'CommandOrControl+Shift+K', 3000);
    const label = await waitFor(
      'atajo nuevo en el panel',
      async () => {
        const text = await js<string>(win, `document.querySelector('.settings-keycap').textContent`);
        return text === 'Ctrl + Mayús + K' ? text : null;
      },
      3000,
    );
    await shot(win, '21-ajustes-cambiados');

    key(win, 'Escape');
    await waitFor('panel cerrado', () => !win.isVisible(), 3000);
    return { bounds, error, label };
  });

  await step('Idioma: al elegir English en Ajustes, el panel, la rueda y los avisos pasan a inglés', async () => {
    const display = screen.getPrimaryDisplay().workArea;
    await hooks.openSettings({ x: display.x + display.width - 120, y: display.y + display.height + 20 });
    const win = await waitFor('panel visible', () => {
      const w = hooks.settingsWindow();
      return w?.isVisible() ? w : null;
    });
    await sleep(500);
    const english = await js<{ x: number; y: number }>(
      win,
      `(() => { const b = [...document.querySelectorAll('.settings-segment')].find((e) => e.textContent === 'English'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    await click(win, english.x, english.y);
    await waitFor('idioma guardado', () => hooks.config().language === 'en', 3000);
    const title = await waitFor('panel en inglés', async () => {
      const text = await js<string>(win, `document.querySelector('.settings-title').textContent`);
      return text === 'Settings' ? text : null;
    });
    await sleep(300);
    await shot(win, '22-settings-english');
    const lang = await js<string>(win, 'document.documentElement.lang');
    key(win, 'Escape');
    await waitFor('panel cerrado', () => !win.isVisible(), 3000);

    const labels = await open(['foto de prueba.png']);
    await shot(wheel, '23-wheel-english');
    if (!labels.includes('Tools') || !labels.includes('More')) throw new Error(`Pétalos: ${labels.join(', ')}`);
    await choose('WEBP');
    const toastTitle = await waitFor('aviso en inglés', async () => (await toastState()).find((t) => t.title === 'Saved')?.title, 15_000);
    return { title, lang, labels, toastTitle };
  });

  writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ok: results.every((r) => r.ok), results }, null, 2));
  await sleep(300);
  hooks.quit();
}
