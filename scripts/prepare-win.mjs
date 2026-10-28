/**
 * Prepara lo que el instalador de Windows necesita además del código de EFC:
 *
 *  1. El ayudante nativo del Explorador (resources/bin/efc-helper.exe; ver scripts/build-helper.mjs).
 *  2. Los binarios de Windows x64 de sharp (@img/sharp-win32-x64) y del lienzo de pdf.js
 *     (@napi-rs/canvas-win32-x64-msvc). En Windows, `npm install` ya los instala; desde Linux o macOS se
 *     descargan del registro de npm con la misma versión que el paquete principal.
 *  3. FFmpeg para Windows (build/ffmpeg/win32-x64): el mismo ejecutable que distribuye el paquete
 *     ffmpeg-static, con su licencia. Con EFC_NO_FFMPEG=1 se omite (EFC usará el FFmpeg del sistema).
 *
 * Uso: node scripts/prepare-win.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const isWindows = process.platform === 'win32';

function pkgVersion(name) {
  const file = path.join(modules, name, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : null;
}

function step(message) {
  console.log(`[prepare-win] ${message}`);
}

// 1. Ayudante del Explorador -----------------------------------------------------------------------
const helperResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-helper.mjs')], { stdio: 'inherit' });
if (helperResult.status !== 0) process.exit(helperResult.status ?? 1);

// 2. Binarios nativos de Windows ---------------------------------------------------------------------
function ensurePlatformPackage(mainPackage, platformPackage) {
  const version = pkgVersion(mainPackage);
  if (!version) throw new Error(`Falta ${mainPackage} en node_modules: ejecuta «npm install».`);
  const installed = pkgVersion(platformPackage);
  if (installed === version) {
    step(`${platformPackage}@${version} ya está instalado.`);
    return;
  }
  if (isWindows && installed === null) {
    throw new Error(`Falta ${platformPackage}: ejecuta «npm install» (incluye las dependencias opcionales).`);
  }
  step(`Descargando ${platformPackage}@${version} para Windows x64…`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'efc-pack-'));
  try {
    const npm = isWindows ? 'npm.cmd' : 'npm';
    const out = execFileSync(npm, ['pack', `${platformPackage}@${version}`, '--pack-destination', tmp, '--silent'], {
      encoding: 'utf8',
      shell: isWindows,
    }).trim();
    const tarball = path.join(tmp, out.split(/\r?\n/).pop());
    const dest = path.join(modules, ...platformPackage.split('/'));
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', dest, '--strip-components=1']);
    if (pkgVersion(platformPackage) !== version) throw new Error(`No se pudo instalar ${platformPackage}@${version}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

ensurePlatformPackage('sharp', '@img/sharp-win32-x64');
ensurePlatformPackage('@napi-rs/canvas', '@napi-rs/canvas-win32-x64-msvc');

// 3. FFmpeg ------------------------------------------------------------------------------------------
const ffmpegDir = path.join(root, 'build', 'ffmpeg', 'win32-x64');
mkdirSync(ffmpegDir, { recursive: true });
const ffmpegExe = path.join(ffmpegDir, 'ffmpeg.exe');

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.env.EFC_NO_FFMPEG === '1') {
  for (const name of readdirSync(ffmpegDir)) rmSync(path.join(ffmpegDir, name), { force: true });
  writeFileSync(path.join(ffmpegDir, 'LEEME.txt'), 'Compilación sin FFmpeg: EFC usará el FFmpeg del sistema si está instalado.\r\n');
  step('FFmpeg omitido (EFC_NO_FFMPEG=1).');
} else {
  const meta = JSON.parse(readFileSync(path.join(modules, 'ffmpeg-static', 'package.json'), 'utf8'))['ffmpeg-static'];
  const tag = meta?.['binary-release-tag'];
  if (!tag) throw new Error('No se pudo leer la versión de FFmpeg de ffmpeg-static.');
  const stamp = path.join(ffmpegDir, 'VERSION.txt');
  const current = existsSync(stamp) ? readFileSync(stamp, 'utf8').split(/\r?\n/)[0] : '';
  if (existsSync(ffmpegExe) && current === tag) {
    step(`FFmpeg ${tag} ya está preparado.`);
  } else {
    const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}`;
    const local = path.join(modules, 'ffmpeg-static', 'ffmpeg.exe');
    if (isWindows && existsSync(local)) {
      step(`Copiando FFmpeg ${tag} desde ffmpeg-static…`);
      copyFileSync(local, ffmpegExe);
    } else {
      step(`Descargando FFmpeg ${tag} para Windows x64…`);
      writeFileSync(ffmpegExe, gunzipSync(await download(`${base}/ffmpeg-win32-x64.gz`)));
    }
    writeFileSync(path.join(ffmpegDir, 'LICENSE.txt'), await download(`${base}/win32-x64.LICENSE`));
    writeFileSync(path.join(ffmpegDir, 'README.txt'), await download(`${base}/win32-x64.README`));
    const sha = createHash('sha256').update(readFileSync(ffmpegExe)).digest('hex');
    writeFileSync(stamp, `${tag}\r\nSHA-256 ffmpeg.exe: ${sha}\r\nOrigen: ${base}\r\n`);
    step(`FFmpeg ${tag} listo (SHA-256 ${sha.slice(0, 16)}…).`);
  }
}

step('Todo preparado para empaquetar la versión de Windows.');
