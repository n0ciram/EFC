/**
 * Cálculos de posición (puros, sin Electron) para la rueda y la notificación.
 * Todas las coordenadas están en píxeles independientes del dispositivo (DIP).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const rectCenter = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

export const contains = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

const clamp = (v: number, min: number, max: number): number => (min > max ? (min + max) / 2 : Math.min(max, Math.max(min, v)));

/**
 * Punto de anclaje de la rueda: el cursor si está sobre la ventana del Explorador (lo habitual tras
 * hacer clic en el archivo); si no, el archivo enfocado; y como último recurso, el centro de la ventana.
 */
export function chooseAnchor(cursor: Point, explorerWindow: Rect | null, focusedItem: Rect | null): { point: Point; source: 'cursor' | 'item' | 'window' } {
  if (!explorerWindow || contains(explorerWindow, cursor)) return { point: cursor, source: 'cursor' };
  if (focusedItem && focusedItem.width > 0 && focusedItem.height > 0) return { point: rectCenter(focusedItem), source: 'item' };
  return { point: rectCenter(explorerWindow), source: 'window' };
}

export interface WheelPlacement {
  /** Esquina superior izquierda de la ventana. */
  window: Rect;
  /** Centro de la rueda en coordenadas de pantalla. */
  center: Point;
  /** La rueda tuvo que desplazarse para no salirse de la pantalla. */
  shifted: boolean;
}

/**
 * Coloca una ventana cuadrada de lado `windowSize` con la rueda (diámetro `diameter`) centrada en el
 * ancla si es posible, y desplazada lo justo para que el círculo visible quede dentro del área de trabajo.
 */
export function placeWheel(anchor: Point, diameter: number, windowSize: number, workArea: Rect, margin = 8): WheelPlacement {
  const r = diameter / 2;
  const cx = clamp(anchor.x, workArea.x + margin + r, workArea.x + workArea.width - margin - r);
  const cy = clamp(anchor.y, workArea.y + margin + r, workArea.y + workArea.height - margin - r);
  const x = Math.round(cx - windowSize / 2);
  const y = Math.round(cy - windowSize / 2);
  return {
    window: { x, y, width: windowSize, height: windowSize },
    center: { x: x + windowSize / 2, y: y + windowSize / 2 },
    shifted: Math.abs(cx - anchor.x) > 0.5 || Math.abs(cy - anchor.y) > 0.5,
  };
}

/** Coloca la notificación centrada en el ancla y dentro del área de trabajo. */
/**
 * Panel junto al icono de la bandeja, como los de Windows (volumen, red): pegado a la barra de tareas
 * donde esté (abajo, arriba o a un lado) y centrado en el icono sin salirse del área de trabajo. Si el
 * icono está dentro del área de trabajo (en la ventana de iconos ocultos «^»), el panel va encima.
 */
export function placeFlyout(anchor: Rect, width: number, height: number, workArea: Rect, margin = 0): Rect {
  const cx = anchor.x + anchor.width / 2;
  const cy = anchor.y + anchor.height / 2;
  const right = workArea.x + workArea.width;
  const bottom = workArea.y + workArea.height;
  let x = cx - width / 2;
  let y = anchor.y - height - margin;
  if (cy >= bottom) y = bottom - height - margin; // barra de tareas abajo
  else if (cy <= workArea.y) y = workArea.y + margin; // arriba
  else if (cx >= right || cx <= workArea.x) {
    // a la derecha o a la izquierda: a la altura del icono
    y = cy - height / 2;
    x = cx >= right ? right - width - margin : workArea.x + margin;
  }
  x = clamp(x, workArea.x + margin, right - width - margin);
  y = clamp(y, workArea.y + margin, bottom - height - margin);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function placeToast(anchor: Point, width: number, height: number, workArea: Rect, margin = 12): Rect {
  const x = clamp(anchor.x - width / 2, workArea.x + margin, workArea.x + workArea.width - width - margin);
  const y = clamp(anchor.y - height / 2, workArea.y + margin, workArea.y + workArea.height - height - margin);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
