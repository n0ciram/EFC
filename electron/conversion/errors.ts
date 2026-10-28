/**
 * Errores de conversión con un código estable. El aviso muestra el texto de ese código en el idioma
 * de la interfaz (src/i18n); el mensaje en español queda para el registro.
 */
import { es } from '../../src/i18n/es';

export type ConversionErrorCode =
  | 'not_found'
  | 'not_a_file'
  | 'unreadable'
  | 'empty'
  | 'changed'
  | 'unsupported'
  | 'corrupt'
  | 'too_large'
  | 'password'
  | 'no_audio'
  | 'no_text'
  | 'write_failed'
  | 'engine_unavailable'
  | 'verify_failed'
  | 'cancelled'
  | 'already_small'
  | 'single_page'
  | 'protected'
  | 'doc_password'
  | 'nothing_to_print'
  | 'office_start'
  | 'office_open'
  | 'office_failed'
  | 'office_timeout'
  | 'unknown';

/** Mensaje en español (registro de diagnóstico). La interfaz lo traduce a partir del código. */
const MESSAGES: Record<ConversionErrorCode, string> = es.errors;

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  /** Detalle técnico para el registro (no se muestra en la interfaz). */
  readonly detail: string | undefined;

  constructor(code: ConversionErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'ConversionError';
    this.code = code;
    this.detail = detail;
  }
}

export function userMessage(code: ConversionErrorCode): string {
  return MESSAGES[code];
}

/** Traduce errores de Node y de los motores a un `ConversionError` con el código más útil. */
export function toConversionError(err: unknown, fallback: ConversionErrorCode = 'unknown'): ConversionError {
  if (err instanceof ConversionError) return err;
  const e = err as (Error & { code?: string; name?: string }) | undefined;
  const message = e?.message ?? String(err);
  const code = e?.code;
  if (e?.name === 'AbortError') return new ConversionError('cancelled', message);
  if (code === 'ENOENT') return new ConversionError('not_found', message);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return new ConversionError(fallback === 'write_failed' ? 'write_failed' : 'unreadable', message);
  if (code === 'ENOSPC') return new ConversionError('write_failed', `Disco lleno: ${message}`);
  if (/pixel limit|exceeds pixel limit|too large/i.test(message)) return new ConversionError('too_large', message);
  if (/unsupported image format|Input buffer contains unsupported|Input file contains unsupported/i.test(message)) {
    return new ConversionError('corrupt', message);
  }
  if (/corrupt|premature end|truncated|invalid|bad seek|VipsJpeg|VipsPng|vips_|not a known file format/i.test(message)) {
    return new ConversionError('corrupt', message);
  }
  return new ConversionError(fallback, message);
}
