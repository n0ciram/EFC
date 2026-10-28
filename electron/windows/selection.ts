/**
 * Validación de la selección del Explorador antes de mostrar la rueda.
 *
 * Las rutas proceden del Explorador, pero se validan igualmente: deben ser rutas absolutas de disco o
 * de red (nunca espacios de nombres de dispositivo), existir, ser archivos normales y tener un
 * contenido reconocible. Nada del archivo se interpreta ni se ejecuta: solo se leen sus primeros bytes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FormatId } from '../../src/types/formats';
import { detectFormat, DETECT_HEADER_BYTES } from '../conversion/detect';
import type { Messages } from '../../src/i18n';
import type { HelperItem } from './explorer-helper';

export type RejectReason = keyof Messages['rejected'];

export const MAX_SELECTION = 200;

export interface SelectedFile {
  path: string;
  name: string;
  size: number;
  format: FormatId;
  /** La extensión no coincide con el contenido real. */
  extensionMismatch: boolean;
}

export interface SelectionResult {
  files: SelectedFile[];
  folders: number;
  /** Motivo como clave de `Messages['rejected']`: se traduce al mostrarlo. */
  rejected: { name: string; reason: RejectReason }[];
  tooMany: boolean;
}

// Controles C0, DEL y comillas/barras/caracteres no permitidos en nombres de Windows (excepto el separador).
const FORBIDDEN = /[\u0000-\u001f\u007f<>"|?*]/;

/** Comprueba que una ruta es absoluta, local o de red, y sin trucos de espacio de nombres. */
export function isSafePath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof p !== 'string' || p.length < 3 || p.length > 32_000) return false;
  if (platform !== 'win32') return path.isAbsolute(p) && !p.includes('\u0000');
  if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\') || p.startsWith('//')) return false;
  const drive = /^[A-Za-z]:\\/.test(p);
  const unc = /^\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+/.test(p);
  if (!drive && !unc) return false;
  // El «:» solo puede aparecer tras la letra de unidad (evita flujos alternativos NTFS «archivo:flujo»).
  const rest = drive ? p.slice(2) : p;
  if (rest.includes(':')) return false;
  if (FORBIDDEN.test(rest)) return false;
  return true;
}

async function readHeader(filePath: string, size: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = new Uint8Array(Math.min(DETECT_HEADER_BYTES, size));
    await handle.read(header, 0, header.length, 0);
    return header;
  } finally {
    await handle.close();
  }
}

export async function resolveSelection(items: readonly HelperItem[], platform: NodeJS.Platform = process.platform): Promise<SelectionResult> {
  const result: SelectionResult = { files: [], folders: 0, rejected: [], tooMany: false };
  const seen = new Set<string>();

  for (const item of items) {
    if (item.isFolder) {
      result.folders++;
      continue;
    }
    const name = item.name || path.basename(item.path);
    if (!item.isFileSystem) {
      result.rejected.push({ name, reason: 'virtual' });
      continue;
    }
    if (item.isLink) {
      result.rejected.push({ name, reason: 'shortcut' });
      continue;
    }
    if (!isSafePath(item.path, platform)) {
      result.rejected.push({ name, reason: 'invalidPath' });
      continue;
    }
    const key = platform === 'win32' ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (result.files.length >= MAX_SELECTION) {
      result.tooMany = true;
      break;
    }
    try {
      const stat = await fs.stat(item.path);
      if (!stat.isFile()) {
        result.rejected.push({ name, reason: 'notFile' });
        continue;
      }
      if (stat.size === 0) {
        result.rejected.push({ name, reason: 'empty' });
        continue;
      }
      const header = await readHeader(item.path, stat.size);
      const detection = detectFormat(header, path.basename(item.path));
      if (!detection.format) {
        result.rejected.push({ name, reason: 'unknownFormat' });
        continue;
      }
      result.files.push({
        path: item.path,
        name: path.basename(item.path),
        size: stat.size,
        format: detection.format,
        extensionMismatch: detection.mismatch,
      });
    } catch {
      result.rejected.push({ name, reason: 'unreadable' });
    }
  }
  return result;
}

/** Tamaño legible («1,2 MB» en español, «1.2 MB» en inglés). */
export { formatBytes } from '../../src/i18n';
