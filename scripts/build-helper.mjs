/**
 * Compila el ayudante nativo del Explorador (electron/windows/helper/efc-helper.cpp) para Windows x64.
 *
 * El ejecutable resultante se guarda en `resources/bin/efc-helper.exe` y forma parte del proyecto, de
 * modo que compilar EFC no exige ningún compilador de C++: solo hace falta volver a ejecutar este
 * script si se modifica el código del ayudante. Toolchains admitidas (la primera que encuentre):
 *
 *   1. clang + lld con las cabeceras y bibliotecas de importación de mingw-w64 en EFC_MINGW_SYSROOT
 *      (carpeta con `include/` y `lib/`). Es la que se usó para el binario incluido.
 *   2. MinGW-w64 GCC: `x86_64-w64-mingw32-g++` y `x86_64-w64-mingw32-windres` (Linux, MSYS2, llvm-mingw).
 *
 * Uso: node scripts/build-helper.mjs [--require]   (--require: falla si no hay toolchain)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'electron', 'windows', 'helper');
const source = path.join(srcDir, 'efc-helper.cpp');
const rc = path.join(srcDir, 'efc-helper.rc');
const output = path.join(root, 'resources', 'bin', 'efc-helper.exe');
const required = process.argv.includes('--require');

const LIBS = ['kernel32', 'user32', 'ole32', 'oleaut32', 'shell32', 'gdi32'];
const CXXFLAGS = [
  '-std=c++17',
  '-O2',
  '-Wall',
  '-Wextra',
  '-fno-exceptions',
  '-fno-rtti',
  '-fno-threadsafe-statics',
  '-fno-asynchronous-unwind-tables',
  '-ffunction-sections',
  '-fdata-sections',
];
const LDFLAGS = [
  '-nostdlib',
  '-Wl,-e,EfcEntry',
  '-Wl,--subsystem,windows:6.1',
  '-Wl,--gc-sections',
  '-Wl,--no-insert-timestamp',
  '-Wl,--dynamicbase',
  '-Wl,--nxcompat',
  '-Wl,--high-entropy-va',
];

/** El programa existe (aunque `--version` no le guste, como a llvm-rc). */
function has(cmd) {
  const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return !probe.error;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: srcDir });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  if (result.stderr?.trim()) console.warn(result.stderr.trim());
}

function clangResourceDir() {
  const r = spawnSync('clang', ['-print-resource-dir'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function buildWithClang(sysroot, tmp) {
  const resourceDir = clangResourceDir();
  const target = '--target=x86_64-w64-mingw32';
  const include = ['-nostdinc', ...(resourceDir ? ['-isystem', path.join(resourceDir, 'include')] : []), '-isystem', path.join(sysroot, 'include')];
  const obj = path.join(tmp, 'efc-helper.o');
  const res = path.join(tmp, 'efc-helper.res');
  const resObj = path.join(tmp, 'efc-helper-res.obj');
  run('clang++', [target, ...CXXFLAGS, ...include, '-c', source, '-o', obj]);
  run('llvm-rc', ['/fo', res, rc]);
  run('llvm-cvtres', ['/machine:x64', `/out:${resObj}`, res]);
  run('clang++', [target, '-fuse-ld=lld', ...LDFLAGS, obj, resObj, `-L${path.join(sysroot, 'lib')}`, ...LIBS.map((l) => `-l${l}`), '-o', output]);
}

function buildWithGcc(tmp) {
  const obj = path.join(tmp, 'efc-helper.o');
  const resObj = path.join(tmp, 'efc-helper-res.o');
  run('x86_64-w64-mingw32-g++', [...CXXFLAGS, '-c', source, '-o', obj]);
  run('x86_64-w64-mingw32-windres', ['-i', rc, '-o', resObj, '-O', 'coff']);
  run('x86_64-w64-mingw32-g++', [...LDFLAGS, obj, resObj, ...LIBS.map((l) => `-l${l}`), '-o', output]);
}

const upToDate = existsSync(output) && statSync(output).mtimeMs >= Math.max(statSync(source).mtimeMs, statSync(rc).mtimeMs);
if (upToDate && !process.argv.includes('--force')) {
  console.log('[helper] resources/bin/efc-helper.exe está actualizado.');
  process.exit(0);
}

const sysroot = process.env.EFC_MINGW_SYSROOT;
const toolchain =
  sysroot && existsSync(path.join(sysroot, 'include', 'windows.h')) && has('clang++') && has('llvm-rc')
    ? 'clang'
    : has('x86_64-w64-mingw32-g++')
      ? 'gcc'
      : null;

if (!toolchain) {
  const message = '[helper] No hay toolchain de MinGW-w64: se usa el ejecutable incluido en resources/bin.';
  if (required || !existsSync(output)) {
    console.error(`${message}\n[helper] ERROR: falta resources/bin/efc-helper.exe y no se puede compilar.`);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

mkdirSync(path.dirname(output), { recursive: true });
const tmp = mkdtempSync(path.join(os.tmpdir(), 'efc-helper-'));
try {
  if (toolchain === 'clang') buildWithClang(sysroot, tmp);
  else buildWithGcc(tmp);
  console.log(`[helper] efc-helper.exe compilado con ${toolchain} (${statSync(output).size} bytes).`);
} catch (err) {
  console.error(`[helper] ERROR al compilar:\n${err.message}`);
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
