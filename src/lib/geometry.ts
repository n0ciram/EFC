/**
 * Geometría de la rueda: sectores anulares con separación constante y esquinas redondeadas.
 * Ángulos en grados, 0° = arriba, sentido horario (como un reloj).
 */

export interface WheelGeometry {
  /** Radio del disco de cristal. */
  outer: number;
  /** Radio exterior de los pétalos. */
  petalOuter: number;
  /** Radio interior de los pétalos. */
  petalInner: number;
  /** Radio del hueco central. */
  well: number;
  /** Radio de la esfera central. */
  orb: number;
  /** Separación entre pétalos (px). */
  gap: number;
  /** Radio de las esquinas exteriores e interiores de cada pétalo. */
  cornerOuter: number;
  cornerInner: number;
}

/** Proporciones de la rueda a partir del diámetro (300 px por defecto). */
export function wheelGeometry(diameter: number): WheelGeometry {
  const r = diameter / 2;
  return {
    outer: r,
    petalOuter: r * 0.947,
    petalInner: r * 0.455,
    well: r * 0.41,
    orb: r * 0.35,
    gap: Math.max(4, r * 0.034),
    cornerOuter: r * 0.085,
    cornerInner: r * 0.055,
  };
}

const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180;

export function polar(cx: number, cy: number, radius: number, angleDeg: number): { x: number; y: number } {
  const a = rad(angleDeg);
  return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
}

/** Ángulo central (grados) del sector `index` de `count`; el primero queda arriba. */
export function sectorCenterAngle(index: number, count: number): number {
  return (360 / count) * index;
}

const fmt = (n: number): string => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(3));

interface Vec {
  x: number;
  y: number;
}

/**
 * Trazado SVG de un pétalo: sector anular entre `a0` y `a1` con separación constante `gap` respecto a
 * los vecinos (los bordes son paralelos al radio, no convergen) y esquinas redondeadas tangentes.
 */
export function petalPath(cx: number, cy: number, g: WheelGeometry, a0: number, a1: number): string {
  const span = a1 - a0;
  if (span >= 359.999) {
    // Un único destino: anillo completo. Cada circunferencia va en dos semicírculos: un arco con el
    // inicio y el final casi en el mismo punto deja el centro ambiguo y el navegador puede dibujarlo
    // fuera de la rueda. El hueco va en sentido contrario para que quede vacío.
    const o = g.petalOuter;
    const i = g.petalInner;
    return [
      `M ${fmt(cx)} ${fmt(cy - o)}`,
      `A ${fmt(o)} ${fmt(o)} 0 0 1 ${fmt(cx)} ${fmt(cy + o)}`,
      `A ${fmt(o)} ${fmt(o)} 0 0 1 ${fmt(cx)} ${fmt(cy - o)} Z`,
      `M ${fmt(cx)} ${fmt(cy - i)}`,
      `A ${fmt(i)} ${fmt(i)} 0 0 0 ${fmt(cx)} ${fmt(cy + i)}`,
      `A ${fmt(i)} ${fmt(i)} 0 0 0 ${fmt(cx)} ${fmt(cy - i)} Z`,
    ].join(' ');
  }

  const d = g.gap / 2;
  // Bordes radiales: dirección u y normal n hacia el interior del sector.
  const edge = (angle: number, inward: 1 | -1): { u: Vec; n: Vec } => {
    const a = rad(angle);
    const u = { x: Math.cos(a), y: Math.sin(a) };
    // Normal perpendicular: rotar u ±90°. En pantalla (y hacia abajo) el sentido horario aumenta el ángulo.
    const n = inward === 1 ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
    return { u, n };
  };
  const start = edge(a0, 1); // borde inicial: el interior está hacia ángulos mayores
  const end = edge(a1, -1); // borde final: el interior está hacia ángulos menores

  const corner = (e: { u: Vec; n: Vec }, radius: number, rc: number, outerSide: boolean) => {
    // Centro del círculo de acuerdo: a distancia rc del borde (desplazado d) y tangente a la circunferencia.
    const off = d + rc;
    const dist = outerSide ? radius - rc : radius + rc;
    const s = Math.sqrt(Math.max(0, dist * dist - off * off));
    const c = { x: e.u.x * s + e.n.x * off, y: e.u.y * s + e.n.y * off };
    const onEdge = { x: e.u.x * s + e.n.x * d, y: e.u.y * s + e.n.y * d };
    const k = radius / dist;
    const onCircle = { x: c.x * k, y: c.y * k };
    return { onEdge, onCircle };
  };

  const so = corner(start, g.petalOuter, g.cornerOuter, true);
  const eo = corner(end, g.petalOuter, g.cornerOuter, true);
  const ei = corner(end, g.petalInner, g.cornerInner, false);
  const si = corner(start, g.petalInner, g.cornerInner, false);

  const P = (v: Vec): string => `${fmt(cx + v.x)} ${fmt(cy + v.y)}`;
  const outerLarge = span > 180 ? 1 : 0;
  return [
    `M ${P(so.onEdge)}`,
    `A ${fmt(g.cornerOuter)} ${fmt(g.cornerOuter)} 0 0 1 ${P(so.onCircle)}`,
    `A ${fmt(g.petalOuter)} ${fmt(g.petalOuter)} 0 ${outerLarge} 1 ${P(eo.onCircle)}`,
    `A ${fmt(g.cornerOuter)} ${fmt(g.cornerOuter)} 0 0 1 ${P(eo.onEdge)}`,
    `L ${P(ei.onEdge)}`,
    `A ${fmt(g.cornerInner)} ${fmt(g.cornerInner)} 0 0 1 ${P(ei.onCircle)}`,
    `A ${fmt(g.petalInner)} ${fmt(g.petalInner)} 0 ${outerLarge} 0 ${P(si.onCircle)}`,
    `A ${fmt(g.cornerInner)} ${fmt(g.cornerInner)} 0 0 1 ${P(si.onEdge)}`,
    'Z',
  ].join(' ');
}

export type HitResult = { kind: 'outside' } | { kind: 'center' } | { kind: 'sector'; index: number };

/**
 * Qué hay bajo el cursor. Los huecos entre pétalos cuentan como el pétalo más cercano (objetivos
 * más grandes, selección más cómoda).
 */
export function hitTest(x: number, y: number, cx: number, cy: number, g: WheelGeometry, count: number): HitResult {
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.hypot(dx, dy);
  if (r > g.outer) return { kind: 'outside' };
  if (r < g.well || count === 0) return { kind: 'center' };
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // 0° arriba
  if (angle < 0) angle += 360;
  const step = 360 / count;
  const index = Math.floor(((angle + step / 2) % 360) / step);
  return { kind: 'sector', index };
}
