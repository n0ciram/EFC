/** Ajustes de calidad de las conversiones (configurables en `config.json`). */
export interface ConversionSettings {
  /** Calidad JPEG (1–100). */
  jpegQuality: number;
  /** Calidad WebP con pérdidas (1–100). Las imágenes sin pérdidas de origen se guardan en WebP sin pérdidas. */
  webpQuality: number;
  /** Calidad AVIF (1–100). */
  avifQuality: number;
  /** Resolución al convertir páginas de PDF a imagen. */
  pdfDpi: number;
  /** Lado mayor mínimo al rasterizar un SVG pequeño (los vectores no pierden calidad al ampliarse). */
  svgMinSize: number;
  /** «Reducir»: lado mayor máximo de las imágenes (px). */
  shrinkMaxSide: number;
  /** «Reducir»: calidad de JPEG, WebP y PNG con paleta (1–100; AVIF usa unos 20 puntos menos). */
  shrinkQuality: number;
  /** «Reducir»: lado mayor máximo de los vídeos (px; 1280 = 720p). */
  shrinkVideoMaxSide: number;
  /** «Reducir»: CRF de H.264 (más alto = más ligero; 23 alta calidad, 28 equilibrado, 32 muy ligero). */
  shrinkVideoCrf: number;
}

export const DEFAULT_CONVERSION_SETTINGS: Readonly<ConversionSettings> = {
  jpegQuality: 90,
  webpQuality: 90,
  avifQuality: 60,
  pdfDpi: 200,
  svgMinSize: 1024,
  shrinkMaxSide: 1920,
  shrinkQuality: 80,
  shrinkVideoMaxSide: 1280,
  shrinkVideoCrf: 28,
};

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
};

export function sanitizeConversionSettings(input: Partial<Record<keyof ConversionSettings, unknown>> | undefined): ConversionSettings {
  const d = DEFAULT_CONVERSION_SETTINGS;
  return {
    jpegQuality: clampInt(input?.jpegQuality, 1, 100, d.jpegQuality),
    webpQuality: clampInt(input?.webpQuality, 1, 100, d.webpQuality),
    avifQuality: clampInt(input?.avifQuality, 1, 100, d.avifQuality),
    pdfDpi: clampInt(input?.pdfDpi, 72, 600, d.pdfDpi),
    svgMinSize: clampInt(input?.svgMinSize, 16, 8192, d.svgMinSize),
    shrinkMaxSide: clampInt(input?.shrinkMaxSide, 320, 8192, d.shrinkMaxSide),
    shrinkQuality: clampInt(input?.shrinkQuality, 30, 95, d.shrinkQuality),
    shrinkVideoMaxSide: clampInt(input?.shrinkVideoMaxSide, 240, 3840, d.shrinkVideoMaxSide),
    shrinkVideoCrf: clampInt(input?.shrinkVideoCrf, 18, 40, d.shrinkVideoCrf),
  };
}
