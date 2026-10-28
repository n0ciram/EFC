/**
 * Pruebas de extremo a extremo con Electron real (rueda, avisos, IPC, conversión y archivos en disco).
 *
 * Uso: npm run test:e2e   (requiere haber ejecutado «npm run build»)
 * En Linux sin escritorio se ejecuta dentro de Xvfb (xvfb-run). Las capturas y el informe se guardan
 * en logs/e2e/.
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
const out = path.join(root, 'logs', 'e2e');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!existsSync(path.join(root, 'dist', 'electron', 'main.cjs'))) {
  console.error('Falta la compilación: ejecuta «npm run build» antes.');
  process.exit(1);
}

// 1. Controlador.
const driver = path.join(root, 'dist', 'e2e', 'driver.cjs');
await build({
  entryPoints: [path.join(root, 'tests', 'e2e', 'driver.ts')],
  outfile: driver,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
});

// 2. Archivos de prueba en una carpeta con espacios y acentos.
const base = mkdtempSync(path.join(os.tmpdir(), 'efc-e2e-'));
const dir = path.join(base, 'Carpeta de pruebas — ñ á é');
mkdirSync(dir, { recursive: true });
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

async function png(name, w, h, hue) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 255) / w;
      data[i + 1] = (y * 255) / h;
      data[i + 2] = hue;
      data[i + 3] = x < w / 5 ? 0 : 255;
    }
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(dir, name));
}
await png('foto de prueba.png', 640, 400, 120);
await png('segunda imagen.png', 400, 300, 40);
await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#7a8ca0', noise: { type: 'gaussian', mean: 128, sigma: 28 } } }).jpeg({ quality: 95 }).toFile(path.join(dir, 'foto grande.jpg'));
await png('Fotografía del almacén — revisión final (copia número 2) ñandú.png', 300, 300, 200);
// PNG con firma válida pero contenido roto.
writeFileSync(path.join(dir, 'dañado.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 7)]));

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) {
  const page = pdf.addPage([595, 842]);
  page.drawText(`Informe trimestral — página ${i}`.replace('—', '-').replace('á', 'a'), { x: 60, y: 760, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawRectangle({ x: 60, y: 120, width: 200, height: 200, color: rgb(0.2, 0.3, 0.7) });
}
writeFileSync(path.join(dir, 'informe trimestral.pdf'), await pdf.save());
const annex = await PDFDocument.create();
annex.addPage([595, 842]).drawText('Anexo', { x: 60, y: 760, size: 22, font: await annex.embedFont(StandardFonts.Helvetica) });
writeFileSync(path.join(dir, 'anexo.pdf'), await annex.save());
writeFileSync(path.join(dir, 'notas del pedido.txt'), 'Pedido nº 42 — entrega en Valencia\r\nCliente:\tFábrica Ñandú\r\nImporte:\t1.250,00 €\r\n', 'utf8');
// Documento de Word creado con Office (solo se convierte si el equipo tiene Word).
writeFileSync(path.join(dir, 'informe de Word.docx'), readFileSync(path.join(root, 'tests', 'fixtures', 'office', 'word.docx')));

let ffmpeg = null;
try {
  ffmpeg = require('ffmpeg-static');
} catch {
  // sin ffmpeg-static
}
if (!ffmpeg || !existsSync(ffmpeg)) ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null;
if (ffmpeg) {
  const run = (args) => spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', path.join(dir, 'grabación.wav')]);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-c:a', 'aac', '-shortest', path.join(dir, 'vídeo full hd.mp4')]);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(dir, 'vídeo largo.mp4')]);
}

// 3. Escritorio virtual (Linux sin pantalla): Xvfb con un fondo de colores para comprobar el cristal.
const SCREEN = { width: 1440, height: 900 };
const wallpaper = path.join(out, 'fondo-escritorio.png');
await sharp(
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN.width}" height="${SCREEN.height}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f2a93b"/><stop offset="0.5" stop-color="#ef5b3f"/><stop offset="1" stop-color="#7d6bd6"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
      ${Array.from({ length: 6 }, (_, i) => `<rect x="${520 + (i % 3) * 120}" y="${300 + Math.floor(i / 3) * 140}" width="70" height="86" rx="6" fill="#fff" fill-opacity="0.92"/><text x="${555 + (i % 3) * 120}" y="${410 + Math.floor(i / 3) * 140}" font-family="Arial" font-size="13" text-anchor="middle" fill="#fff">archivo ${i + 1}</text>`).join('')}
    </svg>`,
  ),
)
  .png()
  .toFile(wallpaper);

let xvfb = null;
let display = process.env.DISPLAY;
if (process.platform === 'linux' && !display) {
  display = `:${90 + Math.floor(Math.random() * 400)}`;
  xvfb = spawn('Xvfb', [display, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  spawnSync('display', ['-window', 'root', wallpaper], { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
}

// 4. Electron.
const electron = require('electron');
const userData = mkdtempSync(path.join(os.tmpdir(), 'efc-e2e-userdata-'));
const electronArgs = [root, `--user-data-dir=${userData}`];
if (process.platform === 'linux' && process.getuid?.() === 0) electronArgs.push('--no-sandbox');
const command = electron;
const args = electronArgs;
const env = { ...process.env, EFC_E2E_DRIVER: driver, EFC_E2E_DIR: dir, EFC_E2E_OUT: out, EFC_E2E_WALLPAPER: wallpaper, EFC_DEV: '1', ...(display ? { DISPLAY: display } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
const logLines = [];
const keep = (chunk) => {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (!line.trim()) continue;
    logLines.push(line);
    if (line.startsWith('[e2e]') || /ERROR|error/.test(line)) console.log(line);
  }
};
child.stdout.on('data', keep);
child.stderr.on('data', keep);
const timer = setTimeout(() => {
  console.error('Tiempo agotado: se detiene Electron.');
  child.kill('SIGKILL');
}, 240_000);
const code = await new Promise((resolve) => child.on('exit', resolve));
clearTimeout(timer);
xvfb?.kill();
writeFileSync(path.join(out, 'electron.log'), logLines.join('\n'));

// Las ventanas transparentes se componen sobre el fondo, como hace Windows (DWM), para revisarlas.
const placementsFile = path.join(out, 'placements.json');
if (xvfb && existsSync(placementsFile)) {
  for (const p of JSON.parse(readFileSync(placementsFile, 'utf8'))) {
    const shotFile = path.join(out, `${p.name}.png`);
    if (!existsSync(shotFile)) continue;
    const meta = await sharp(shotFile).metadata();
    const left = Math.max(0, p.x - 60);
    const top = Math.max(0, p.y - 60);
    const width = Math.min(SCREEN.width - left, meta.width + 120);
    const height = Math.min(SCREEN.height - top, meta.height + 120);
    // sharp aplica `extract` antes que `composite` dentro de una misma cadena: se hace en dos pasos.
    const composed = await sharp(wallpaper).composite([{ input: shotFile, left: p.x, top: p.y }]).png().toBuffer();
    await sharp(composed)
      .extract({ left, top, width, height })
      .png()
      .toFile(path.join(out, `${p.name} (sobre el escritorio).png`));
  }
}

const reportFile = path.join(out, 'report.json');
if (!existsSync(reportFile)) {
  console.error(`Electron terminó (código ${code}) sin informe. Registro: ${path.join(out, 'electron.log')}`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const failed = report.results.filter((r) => !r.ok);
console.log(`\n${report.results.length - failed.length}/${report.results.length} pasos correctos. Capturas e informe en ${out}`);
rmSync(base, { recursive: true, force: true });
rmSync(userData, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
