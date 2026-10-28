/**
 * Compila el proceso principal, el script de precarga y el proceso de conversión con esbuild.
 * Uso: node scripts/build-electron.mjs [--watch]
 */
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

/** Módulos nativos o con recursos propios: se cargan desde node_modules en tiempo de ejecución. */
const runtimeExternal = ['electron', 'sharp', 'pdfjs-dist', '@napi-rs/canvas', 'ffmpeg-static', 'pdf-lib'];

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: watch ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  outdir: path.join(root, 'dist', 'electron'),
  outExtension: { '.js': '.cjs' },
};

const configs = [
  { ...common, entryPoints: { main: path.join(root, 'electron/main/main.ts') }, external: runtimeExternal },
  { ...common, entryPoints: { worker: path.join(root, 'electron/conversion/worker.ts') }, external: runtimeExternal },
  // La precarga se ejecuta en el sandbox: todo debe ir en un único archivo salvo «electron».
  { ...common, entryPoints: { preload: path.join(root, 'electron/preload/preload.ts') }, external: ['electron'] },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[electron] Vigilando cambios…');
} else {
  await Promise.all(configs.map((c) => build(c)));
}
