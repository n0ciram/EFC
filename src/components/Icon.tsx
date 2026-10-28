/**
 * Iconos de trazo propios (rejilla de 24 px, trazo de 1,6 px, puntas redondeadas).
 * Heredan el color del texto: la interfaz no usa colores de acento.
 */
import type { IconId } from '../types/formats';

const PATHS: Record<IconId, string[]> = {
  photo: ['M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z', 'm4.5 16.5 4.2-4.2a1.5 1.5 0 0 1 2.1 0L16 17.5', 'm13.5 15 1.7-1.7a1.5 1.5 0 0 1 2.1 0l2.2 2.2', 'M15.5 9.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5'],
  'photo-alpha': ['M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z', 'M4 12h8V4', 'M12 12h8', 'M12 12v8', 'M8 4v4H4', 'M16 12v4h4'],
  web: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'M4 12h16', 'M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8c-2.2-2.3-3.2-5-3.2-8s1-5.7 3.2-8'],
  sparkle: ['M12 3.5 13.9 9a2 2 0 0 0 1.2 1.2l5.4 1.8-5.4 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.1 15a2 2 0 0 0-1.2-1.2L3.5 12l5.4-1.8A2 2 0 0 0 10.1 9z'],
  grid: ['M4.5 4.5h15v15h-15z', 'M9.5 4.5v15', 'M14.5 4.5v15', 'M4.5 9.5h15', 'M4.5 14.5h15'],
  layers: ['m12 4 8 4-8 4-8-4z', 'm4 12 8 4 8-4', 'm4 16 8 4 8-4'],
  frames: ['M7 5.5h10A1.5 1.5 0 0 1 18.5 7v10a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17V7A1.5 1.5 0 0 1 7 5.5', 'M3 8.5v7', 'M21 8.5v7', 'm10.5 9.5 4 2.5-4 2.5z'],
  app: ['M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5z', 'M5 9h14', 'M8 7h.01', 'M10.5 7h.01'],
  vector: ['M6 18 18 6', 'M4.5 16.5h3v3h-3z', 'M16.5 4.5h3v3h-3z', 'M7.5 18c5 0 9-4 9-9'],
  document: ['M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1-1.5', 'M13 3.5V8h5', 'M9 12.5h6', 'M9 16h4'],
  text: ['M5 6h14', 'M5 10h14', 'M5 14h10', 'M5 18h7'],
  note: ['M9 17.5V6l10-2v11.5', 'M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0', 'M19 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0', 'M9 9.5l10-2'],
  wave: ['M3 12h2', 'M7 8v8', 'M11 5v14', 'M15 9v6', 'M19 7v10', 'M21 12h0'],
  'wave-lossless': ['M4 10v4', 'M8 7v10', 'M12 4.5v15', 'M16 7v10', 'M20 10v4'],
  waves: ['M3 9c2 0 2-2 4.5-2S10 9 12 9s2.5-2 4.5-2S19 9 21 9', 'M3 15c2 0 2-2 4.5-2s2.5 2 4.5 2 2.5-2 4.5-2 2.5 2 4.5 2'],
  film: ['M4.5 5h15v14h-15z', 'M8 5v14', 'M16 5v14', 'M4.5 9H8', 'M4.5 15H8', 'M16 9h3.5', 'M16 15h3.5'],
  play: ['M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z', 'm10 9.2 4.8 2.8-4.8 2.8z'],
  merge: ['M8 4.5h7.5L19 8v9.5a1.5 1.5 0 0 1-1.5 1.5H8a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 8 4.5', 'M4 8v11a1.5 1.5 0 0 0 1.5 1.5H14', 'M12.75 9.5v6', 'M9.75 12.5h6'],
  shrink: ['M9.5 4v5.5H4', 'M14.5 4v5.5H20', 'M9.5 20v-5.5H4', 'M14.5 20v-5.5H20', 'M4 4l5.5 5.5', 'M20 4l-5.5 5.5', 'M4 20l5.5-5.5', 'M20 20l-5.5-5.5'],
  split: ['M4.5 6A1.5 1.5 0 0 1 6 4.5h4A1.5 1.5 0 0 1 11.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18z', 'M12.5 6A1.5 1.5 0 0 1 14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z', 'M7 9h2', 'M15 9h2'],
  rotate: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4', 'M9.5 9.5h5v5h-5z'],
  toolbox: ['M4 9.5h16v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z', 'M9 9.5V7a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 7v2.5', 'M4 13.5h16', 'M10.5 12.5v2.5h3v-2.5'],
  more: ['M6.5 12h.01', 'M12 12h.01', 'M17.5 12h.01'],
  back: ['M10 6 4 12l6 6', 'M4.5 12H15a5 5 0 0 1 5 5v1'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  alert: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'M12 8v4.5', 'M12 16h.01'],
  close: ['M7 7l10 10', 'M17 7 7 17'],
  info: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16', 'M12 11v5', 'M12 8h.01'],
};

/** Iconos cuyos puntos necesitan un trazo más grueso para verse. */
const DOTTED: ReadonlySet<IconId> = new Set<IconId>(['more']);

export function Icon({ name, size = 20, className }: { name: IconId; size?: number; className?: string }) {
  const strokeWidth = DOTTED.has(name) ? 3 : 1.6;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
