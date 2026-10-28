/**
 * Opciones de la ventana de ajustes, compartidas por la interfaz y el proceso principal (que valida
 * cada cambio contra estas mismas listas). Sin dependencias de Node ni del DOM. Los textos están
 * en src/i18n.
 */
import type { ImageQuality } from '../types/ipc';

export interface Choice<T> {
  value: T;
  label: string;
}

/** Calidad de JPEG, WebP y AVIF de cada nivel. «Alta» es la de siempre. */
export const QUALITY_PRESETS: Readonly<Record<Exclude<ImageQuality, 'custom'>, { jpegQuality: number; webpQuality: number; avifQuality: number }>> = {
  max: { jpegQuality: 95, webpQuality: 95, avifQuality: 75 },
  high: { jpegQuality: 90, webpQuality: 90, avifQuality: 60 },
  balanced: { jpegQuality: 80, webpQuality: 80, avifQuality: 50 },
};

/** Resolución al pasar páginas de PDF a imagen (ppp). */
export const PDF_DPI_CHOICES: readonly Choice<number>[] = [
  { value: 150, label: '150' },
  { value: 200, label: '200' },
  { value: 300, label: '300' },
];

/** REDUCIR: lado mayor de las fotos (px). */
export const PHOTO_SIZE_CHOICES: readonly Choice<number>[] = [
  { value: 1280, label: '1280' },
  { value: 1920, label: '1920' },
  { value: 2560, label: '2560' },
];

/** REDUCIR: lado mayor de los vídeos (px): 854 = 480p, 1280 = 720p, 1920 = 1080p. */
export const VIDEO_SIZE_CHOICES: readonly Choice<number>[] = [
  { value: 854, label: '480p' },
  { value: 1280, label: '720p' },
  { value: 1920, label: '1080p' },
];

/** Transparencia de la rueda (0–100). 50 es el aspecto original. */
export const DEFAULT_WHEEL_TRANSPARENCY = 50;

/** Multiplicador de la opacidad del cristal de la rueda: 0 → 1,5 (más opaca), 50 → 1, 100 → 0,5. */
export function glassFactor(transparency: number): number {
  const t = Math.min(100, Math.max(0, transparency));
  return Math.round((1.5 - t / 100) * 100) / 100;
}
