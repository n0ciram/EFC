/**
 * Registro de diagnóstico en `%APPDATA%\EFC\logs\efc.log` (rotación sencilla a 1 MB).
 * No registra el contenido de los archivos; las rutas solo aparecen en los errores.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 1024 * 1024;
let logFile: string | null = null;
let verbose = false;

export function initLogger(dir: string, options: { verbose?: boolean } = {}): string {
  mkdirSync(dir, { recursive: true });
  logFile = path.join(dir, 'efc.log');
  verbose = options.verbose ?? false;
  return logFile;
}

export function getLogFile(): string | null {
  return logFile;
}

function rotateIfNeeded(file: string): void {
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, file.replace(/\.log$/, '.old.log'));
  } catch {
    // El archivo aún no existe.
  }
}

function format(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: Level, scope: string, parts: unknown[]): void {
  if (level === 'debug' && !verbose) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${parts.map(format).join(' ')}\n`;
  if (process.env.EFC_DEV === '1' || !logFile) {
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(line);
  }
  if (!logFile) return;
  try {
    rotateIfNeeded(logFile);
    appendFileSync(logFile, line, 'utf8');
  } catch {
    // Si el registro falla no debe afectar a la aplicación.
  }
}

export interface Logger {
  debug(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...parts) => write('debug', scope, parts),
    info: (...parts) => write('info', scope, parts),
    warn: (...parts) => write('warn', scope, parts),
    error: (...parts) => write('error', scope, parts),
  };
}
