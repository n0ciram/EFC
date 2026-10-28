/**
 * Lectura de archivos de origen con validaciones y mensajes claros.
 */
import { promises as fs } from 'node:fs';
import type { FormatId } from '../../src/types/formats';
import { detectFormat, DETECT_HEADER_BYTES } from './detect';
import { ConversionError, toConversionError } from './errors';

/** Tamaño máximo que se carga en memoria de una vez (imágenes y PDF). El audio y el vídeo se leen en flujo. */
export const MAX_IN_MEMORY_BYTES = 1024 * 1024 * 1024; // 1 GB

export interface SourceCheck {
  size: number;
  mtimeMs: number;
}

/** Comprueba que el origen existe, es un archivo, no está vacío y sigue siendo del formato esperado. */
export async function validateSource(filePath: string, expected: FormatId): Promise<SourceCheck> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    throw toConversionError(err, 'unreadable');
  }
  if (!stat.isFile()) throw new ConversionError('not_a_file');
  if (stat.size === 0) throw new ConversionError('empty');

  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const header = new Uint8Array(Math.min(DETECT_HEADER_BYTES, stat.size));
    await handle.read(header, 0, header.length, 0);
    const detected = detectFormat(header, filePath.split(/[\\/]/).pop() ?? '');
    if (detected.format !== expected) {
      throw new ConversionError('changed', `Esperado ${expected}, detectado ${detected.format ?? 'desconocido'}`);
    }
  } catch (err) {
    throw toConversionError(err, 'unreadable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Primeros bytes de un archivo (para comprobaciones de contenido). */
export async function readHeader(filePath: string, bytes = DETECT_HEADER_BYTES): Promise<Uint8Array> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const header = new Uint8Array(bytes);
    const { bytesRead } = await handle.read(header, 0, bytes, 0);
    return header.subarray(0, bytesRead);
  } catch (err) {
    throw toConversionError(err, 'unreadable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Lee un archivo completo en memoria respetando el límite de tamaño. */
export async function readWhole(filePath: string, limit = MAX_IN_MEMORY_BYTES): Promise<Buffer> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > limit) throw new ConversionError('too_large', `${stat.size} bytes`);
    return await fs.readFile(filePath);
  } catch (err) {
    throw toConversionError(err, 'unreadable');
  }
}
