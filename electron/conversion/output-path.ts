/**
 * Nombres de salida y escritura segura.
 *
 * Reglas (según el requisito de guardado automático):
 * - El resultado se guarda junto al original con la nueva extensión: `imagen.jpg`.
 * - Si ya existe, se usa `imagen_converted.jpg`; si también existe, `imagen_converted_2.jpg`, etc.
 * - Nunca se sobrescribe nada: el archivo se escribe primero con un nombre temporal y después
 *   se «publica» con una operación que falla si el destino ya existe.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_CANDIDATES = 9999;

/** Separa un nombre de archivo en base y extensión (sin punto). */
export function splitFileName(fileName: string): { base: string; ext: string } {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return { base: fileName, ext: '' };
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot + 1) };
}

/** Candidatos de nombre de archivo por orden de preferencia. */
export function* fileNameCandidates(base: string, ext: string): Generator<string> {
  const suffix = ext ? `.${ext}` : '';
  yield `${base}${suffix}`;
  yield `${base}_converted${suffix}`;
  for (let n = 2; n <= MAX_CANDIDATES; n++) yield `${base}_converted_${n}${suffix}`;
}

/** Candidatos de nombre de carpeta para resultados de varias páginas: «informe (JPG)», «informe (JPG) 2»… */
export function* folderNameCandidates(base: string, label: string): Generator<string> {
  yield `${base} (${label})`;
  for (let n = 2; n <= MAX_CANDIDATES; n++) yield `${base} (${label}) ${n}`;
}

/** Nombre de cada página dentro de la carpeta: «informe-01.jpg». */
export function pageFileName(base: string, index: number, total: number, ext: string): string {
  const width = Math.max(2, String(total).length);
  return `${base}-${String(index + 1).padStart(width, '0')}.${ext}`;
}

/** Ruta temporal en la misma carpeta que el destino (para poder publicarla sin copiar). */
export function tempPathFor(dir: string, jobId: string, index: number): string {
  return path.join(dir, `.~efc-${jobId}-${index}.part`);
}

export const TEMP_PREFIX = '.~efc-';

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Publica un archivo temporal con el primer nombre libre.
 * Usa un enlace duro (falla si el destino existe, sin carreras); si el sistema de archivos no
 * admite enlaces (FAT32, exFAT, algunas unidades de red) comprueba y renombra.
 * Devuelve la ruta definitiva.
 */
export async function publishFile(tempPath: string, dir: string, base: string, ext: string): Promise<string> {
  let linksSupported = true;
  for (const name of fileNameCandidates(base, ext)) {
    const candidate = path.join(dir, name);
    if (linksSupported) {
      try {
        await fs.link(tempPath, candidate);
        await fs.unlink(tempPath);
        return candidate;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (code === 'ENOENT') throw err;
        linksSupported = false;
      }
    }
    if (await exists(candidate)) continue;
    try {
      await fs.rename(tempPath, candidate);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM') {
        if (await exists(candidate)) continue;
      }
      if (code === 'EXDEV') {
        await fs.copyFile(tempPath, candidate, fsConstants.COPYFILE_EXCL);
        await fs.unlink(tempPath);
        return candidate;
      }
      throw err;
    }
  }
  throw new Error('No se encontró un nombre libre para el archivo de salida.');
}

/** Publica una carpeta temporal con el primer nombre libre. Devuelve la ruta definitiva. */
export async function publishFolder(tempDir: string, parentDir: string, base: string, label: string): Promise<string> {
  for (const name of folderNameCandidates(base, label)) {
    const candidate = path.join(parentDir, name);
    if (await exists(candidate)) continue;
    try {
      await fs.rename(tempDir, candidate);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY') && (await exists(candidate))) continue;
      throw err;
    }
  }
  throw new Error('No se encontró un nombre libre para la carpeta de salida.');
}

/** Borra un archivo o carpeta temporal sin propagar errores (limpieza tras fallos o cancelaciones). */
export async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    // Si no se puede borrar ahora (p. ej. bloqueado por un antivirus) no es crítico.
  }
}
