/**
 * Crea docs/demo.gif, la demostración del README: EFC real, en inglés, sobre un escritorio de ejemplo.
 *
 * Uso: npm run demo:gif   (compila antes). No uses el ratón mientras graba: la rueda sigue al ratón
 * real y estropearía la toma.
 *
 * 1. Prepara archivos de ejemplo y una configuración nueva en inglés.
 * 2. Lanza EFC con scripts/demo/driver.ts, que mueve un cursor simulado y captura las ventanas.
 * 3. Compone cada fotograma (escritorio + ventanas de EFC + cursor) y crea el GIF con FFmpeg.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const ffmpeg = require('ffmpeg-static');
const { PDFDocument } = require('pdf-lib');

const OUTPUT = path.join(root, 'docs', 'demo.gif');
const WIDTH = 900;
const FPS = 15;

if (!existsSync(path.join(root, 'dist', 'electron', 'main.cjs'))) {
  console.error('Falta la compilación: ejecuta «npm run build» antes.');
  process.exit(1);
}

const work = mkdtempSync(path.join(os.tmpdir(), 'efc-demo-'));
const dir = path.join(work, 'Demo');
const out = path.join(work, 'out');
const userData = path.join(work, 'userdata');
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });
mkdirSync(userData, { recursive: true });

// 1. Archivos de ejemplo: una foto y un PDF «escaneado» (con imágenes grandes, para que SHRINK ahorre).
const photo = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fb4f0"/><stop offset="1" stop-color="#cdeeff"/></linearGradient>
      <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8fb8"/><stop offset="1" stop-color="#0b4f7a"/></linearGradient>
    </defs>
    <rect width="2400" height="900" fill="url(#sky)"/>
    <circle cx="1800" cy="300" r="130" fill="#fff6c8"/>
    <rect y="900" width="2400" height="350" fill="url(#sea)"/>
    <path d="M0 1250 Q 600 1150 1200 1230 T 2400 1210 V 1600 H 0 Z" fill="#f1d9a6"/>
  </svg>`,
);
await sharp(photo).png().toFile(path.join(dir, 'beach.png'));

const pdf = await PDFDocument.create();
for (let i = 0; i < 3; i++) {
  const jpg = await sharp({ create: { width: 2480, height: 3508, channels: 3, background: '#e9e4da', noise: { type: 'gaussian', mean: 200, sigma: 30 } } })
    .jpeg({ quality: 92 })
    .toBuffer();
  const image = await pdf.embedJpg(jpg);
  const page = pdf.addPage([595, 842]);
  page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 });
}
writeFileSync(path.join(dir, 'quarterly report.pdf'), await pdf.save());

// Configuración nueva: en inglés y sin el aviso de bienvenida.
writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ language: 'en', welcomeShown: true }));

// 2. Grabación con EFC real.
const driver = path.join(root, 'dist', 'demo', 'driver.cjs');
await build({
  entryPoints: [path.join(root, 'scripts', 'demo', 'driver.ts')],
  outfile: driver,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});
const env = { ...process.env, EFC_E2E_DRIVER: driver, EFC_E2E_DIR: dir, EFC_E2E_OUT: out, EFC_DEV: '1' };
delete env.ELECTRON_RUN_AS_NODE;
console.log('Grabando… (no muevas el ratón)');
const child = spawn(require('electron'), [root, `--user-data-dir=${userData}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const log = [];
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));
const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
await new Promise((resolve) => child.on('exit', resolve));
clearTimeout(timer);
const shotsFile = path.join(out, 'shots.json');
if (!existsSync(shotsFile)) {
  console.error(`La grabación no terminó. Registro:\n${log.join('').slice(-4000)}`);
  process.exit(1);
}

// 3. Composición de los fotogramas y GIF.
const { region, display, backgrounds, shots } = JSON.parse(readFileSync(shotsFile, 'utf8'));
const cursor = await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">
      <path d="M2 2 L2 26 L8 20.5 L12.5 31 L16.6 29.2 L12.2 19 L20.5 19 Z" fill="#111" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
    </svg>`,
  ),
)
  .png()
  .toBuffer();
const bgCache = {};
const framesOut = path.join(work, 'gif');
mkdirSync(framesOut, { recursive: true });
const list = [];
for (const [i, shot] of shots.entries()) {
  bgCache[shot.bg] ??= await sharp(backgrounds[shot.bg]).resize(display.width, display.height).png().toBuffer();
  const layers = [];
  for (const w of shot.windows) {
    const input = await sharp(path.join(out, 'frames', w.file)).resize(w.width, w.height).png().toBuffer();
    layers.push({ input, left: w.x - display.x, top: w.y - display.y });
  }
  layers.push({ input: cursor, left: Math.round(shot.cursor.x - display.x - 2), top: Math.round(shot.cursor.y - display.y - 2) });
  // Lo que se sale del escritorio (ventanas junto al borde) se recorta.
  const safe = layers.filter((l) => l.left >= -2000 && l.top >= -2000);
  const full = await sharp(bgCache[shot.bg]).composite(safe.map((l) => ({ ...l, left: Math.max(0, l.left), top: Math.max(0, l.top) }))).png().toBuffer();
  const file = path.join(framesOut, `f${String(i).padStart(5, '0')}.png`);
  await sharp(full)
    .extract({ left: region.x - display.x, top: region.y - display.y, width: region.width, height: region.height })
    .resize({ width: WIDTH })
    .png()
    .toFile(file);
  const next = shots[i + 1];
  const duration = next ? Math.max(0.02, (next.t - shot.t) / 1000) : 1.2;
  list.push(`file '${file.replace(/\\/g, '/')}'`, `duration ${duration.toFixed(3)}`);
}
list.push(`file '${path.join(framesOut, `f${String(shots.length - 1).padStart(5, '0')}.png`).replace(/\\/g, '/')}'`);
const listFile = path.join(work, 'frames.txt');
writeFileSync(listFile, list.join('\n'));

mkdirSync(path.dirname(OUTPUT), { recursive: true });
const result = spawnSync(
  ffmpeg,
  [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `fps=${FPS},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0',
    OUTPUT,
  ],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`${shots.length} capturas → ${OUTPUT}`);
rmSync(work, { recursive: true, force: true });
