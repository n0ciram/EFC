/**
 * Desenfoque real del escritorio detrás de la rueda.
 *
 * Electron no puede desenfocar otras ventanas con CSS (`backdrop-filter` solo afecta al contenido de
 * la propia página). Justo antes de mostrar la rueda se captura la zona de la pantalla que quedará
 * detrás (el ayudante nativo lo hace con GDI en unos milisegundos; como respaldo se captura la
 * pantalla entera con `desktopCapturer`), y la interfaz la desenfoca dentro del círculo. La captura
 * vive solo en memoria mientras la rueda o los avisos están visibles: nunca se guarda ni se envía.
 *
 * También se calcula la luminosidad media de esa zona para elegir texto oscuro o claro y mantener
 * el contraste sobre cualquier fondo.
 */
import { desktopCapturer, nativeImage, type Display, type NativeImage } from 'electron';
import type { ThemeName, WheelBackdrop } from '../../src/types/ipc';
import { createLogger } from './logger';
import type { Point, Rect } from './placement';

const log = createLogger('fondo');

/** Fracción de la resolución física con la que se captura (el desenfoque oculta la diferencia). */
const QUALITY = 0.5;

export interface DisplayCapture {
  displayId: number;
  bounds: Rect;
  image: NativeImage;
}

export interface CroppedBackdrop {
  backdrop: WheelBackdrop;
  theme: ThemeName;
  luminance: number;
}

function timeout<T>(ms: number): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** Captura una pantalla completa a resolución reducida; `null` si falla o tarda más de `timeoutMs`. */
export async function captureDisplay(display: Display, timeoutMs = 260): Promise<DisplayCapture | null> {
  const started = Date.now();
  const work = (async (): Promise<DisplayCapture | null> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(16, Math.round(display.bounds.width * display.scaleFactor * QUALITY)),
        height: Math.max(16, Math.round(display.bounds.height * display.scaleFactor * QUALITY)),
      },
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) return null;
    return { displayId: display.id, bounds: { ...display.bounds }, image: source.thumbnail };
  })().catch((err: unknown) => {
    log.warn('No se pudo capturar el fondo', err);
    return null;
  });
  const result = await Promise.race([work, timeout<DisplayCapture>(timeoutMs)]);
  log.debug(result ? `Pantalla capturada en ${Date.now() - started} ms` : `Captura del fondo no disponible a tiempo (${Date.now() - started} ms)`);
  return result;
}

/** Captura de una zona de la pantalla en píxeles físicos (la hace el ayudante nativo con GDI). */
export type RegionCapturer = (
  physical: Rect,
  percent: number,
) => Promise<{ width: number; height: number; bgra: Buffer } | null>;

/** Intersección de dos rectángulos, o `null` si no se solapan. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Captura solo la zona que quedará detrás de la rueda y del aviso (mucho más rápido que capturar la
 * pantalla entera). `toPhysical` convierte DIP → píxeles físicos (escalado de Windows).
 */
export async function captureRegion(
  display: Display,
  regionDip: Rect,
  capturer: RegionCapturer,
  toPhysical: (r: Rect) => Rect,
): Promise<DisplayCapture | null> {
  const started = Date.now();
  const clipped = intersectRect(regionDip, display.bounds);
  if (!clipped) return null;
  const physical = toPhysical(clipped);
  // A media resolución: el desenfoque oculta la diferencia y la captura pesa cuatro veces menos.
  const shot = await capturer(physical, 50);
  if (!shot) return null;
  try {
    const image = nativeImage.createFromBitmap(shot.bgra, { width: shot.width, height: shot.height });
    if (image.isEmpty()) return null;
    log.debug(`Zona capturada (${shot.width}×${shot.height}) en ${Date.now() - started} ms`);
    return { displayId: display.id, bounds: clipped, image };
  } catch (err) {
    log.warn('No se pudo crear la imagen de la captura', err);
    return null;
  }
}

/** Recorta la región `regionDip` (coordenadas de pantalla en DIP) y la expresa relativa a la ventana. */
export function cropBackdrop(capture: DisplayCapture, regionDip: Rect, windowOrigin: Point): CroppedBackdrop | null {
  const { bounds, image } = capture;
  const size = image.getSize();
  const kx = size.width / bounds.width;
  const ky = size.height / bounds.height;

  const left = Math.max(regionDip.x, bounds.x);
  const top = Math.max(regionDip.y, bounds.y);
  const right = Math.min(regionDip.x + regionDip.width, bounds.x + bounds.width);
  const bottom = Math.min(regionDip.y + regionDip.height, bounds.y + bounds.height);
  if (right - left < 8 || bottom - top < 8) return null;

  const x = Math.max(0, Math.floor((left - bounds.x) * kx));
  const y = Math.max(0, Math.floor((top - bounds.y) * ky));
  const crop = {
    x,
    y,
    width: Math.min(size.width - x, Math.ceil((right - left) * kx)),
    height: Math.min(size.height - y, Math.ceil((bottom - top) * ky)),
  };
  if (crop.width < 4 || crop.height < 4) return null;

  try {
    const piece = image.crop(crop);
    const pieceSize = piece.getSize();
    const luminance = averageLuminance(piece.toBitmap(), pieceSize.width, pieceSize.height);
    return {
      backdrop: {
        dataUrl: `data:image/jpeg;base64,${piece.toJPEG(82).toString('base64')}`,
        x: left - windowOrigin.x,
        y: top - windowOrigin.y,
        width: right - left,
        height: bottom - top,
      },
      // Fondos claros → cristal blanco y texto oscuro; fondos oscuros → al revés.
      theme: luminance > 0.55 ? 'light' : 'dark',
      luminance,
    };
  } catch (err) {
    log.warn('No se pudo recortar el fondo', err);
    return null;
  }
}

/** Luminosidad perceptual media (0–1, equivalente a L* dividido entre 100) de la zona central de un mapa de bits BGRA. */
export function averageLuminance(bitmap: Uint8Array, width: number, height: number): number {
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return 0.5;
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.ceil(width * 0.8);
  const y0 = Math.floor(height * 0.2);
  const y1 = Math.ceil(height * 0.8);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      const b = bitmap[i] as number;
      const g = bitmap[i + 1] as number;
      const r = bitmap[i + 2] as number;
      sum += 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
      n++;
    }
  }
  const lum = n > 0 ? sum / n : 0.18;
  return lum <= 0.008856 ? (903.3 * lum) / 100 : (116 * Math.cbrt(lum) - 16) / 100;
}
