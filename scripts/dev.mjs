/**
 * Entorno de desarrollo: servidor de Vite para la interfaz (con recarga en caliente), esbuild en modo
 * vigilancia para el proceso principal y reinicio automático de Electron cuando este cambia.
 */
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBinary = require('electron');

// Ayudante del Explorador (solo Windows; si no se puede compilar se usará PowerShell).
spawnSync(process.execPath, [path.join(root, 'scripts', 'build-helper.mjs')], { stdio: 'inherit' });

const server = await createServer({ configFile: path.join(root, 'vite.config.mts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5174/';
console.log(`[dev] Interfaz en ${url}`);

const outdir = path.join(root, 'dist', 'electron');
const external = ['electron', 'sharp', 'pdfjs-dist', '@napi-rs/canvas', 'ffmpeg-static', 'pdf-lib'];
const base = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: 'inline', outdir, outExtension: { '.js': '.cjs' }, logLevel: 'warning' };
const contexts = await Promise.all([
  context({ ...base, entryPoints: { main: path.join(root, 'electron/main/main.ts') }, external }),
  context({ ...base, entryPoints: { worker: path.join(root, 'electron/conversion/worker.ts') }, external }),
  context({ ...base, entryPoints: { preload: path.join(root, 'electron/preload/preload.ts') }, external: ['electron'] }),
]);
await Promise.all(contexts.map((c) => c.rebuild()));

let child = null;
let restarting = false;
function startElectron() {
  // En Linux como root (contenedores) Chromium exige desactivar su sandbox.
  const args = process.platform === 'linux' && process.getuid?.() === 0 ? [root, '--no-sandbox'] : [root];
  child = spawn(electronBinary, args, {
    stdio: 'inherit',
    env: { ...process.env, EFC_DEV_SERVER_URL: url.replace(/\/$/, ''), EFC_DEV: '1' },
  });
  child.on('exit', (code) => {
    if (!restarting) {
      console.log(`[dev] Electron terminó (código ${code}).`);
      shutdown();
    }
  });
}

let timer = null;
function scheduleRestart() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await Promise.all(contexts.map((c) => c.rebuild())).catch((err) => console.error(err));
    if (child) {
      restarting = true;
      child.once('exit', () => {
        restarting = false;
        startElectron();
      });
      child.kill();
    } else startElectron();
  }, 250);
}

watch(path.join(root, 'electron'), { recursive: true }, (_event, file) => {
  if (file && /\.(ts|cs|ps1)$/.test(file)) scheduleRestart();
});

function shutdown() {
  for (const c of contexts) void c.dispose();
  void server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);

startElectron();
