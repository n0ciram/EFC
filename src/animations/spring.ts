/**
 * Muelles físicos convertidos en curvas CSS `linear()`.
 *
 * Se simula un oscilador amortiguado y se muestrea su posición; el resultado se usa como `easing`
 * de la Web Animations API o de transiciones CSS. Así las animaciones elásticas se ejecutan en el
 * hilo de composición del navegador (fluidas aunque el hilo principal esté ocupado) y sin bibliotecas.
 */

export interface SpringConfig {
  /** Rigidez: valores altos = respuesta más rápida. */
  stiffness: number;
  /** Amortiguación: valores bajos = más rebote. */
  damping: number;
  mass?: number;
  /** Velocidad inicial normalizada (unidades del recorrido por segundo). */
  velocity?: number;
}

export interface SpringCurve {
  /** Valor para `easing` / `transition-timing-function`. */
  easing: string;
  /** Duración en milisegundos hasta que el muelle se asienta. */
  duration: number;
  /** Mayor sobrepaso (1 = sin rebote). */
  peak: number;
}

const cache = new Map<string, SpringCurve>();

export function spring(config: SpringConfig): SpringCurve {
  const key = `${config.stiffness}|${config.damping}|${config.mass ?? 1}|${config.velocity ?? 0}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const mass = config.mass ?? 1;
  const dt = 1 / 1000; // 1 ms
  let x = 0;
  let v = config.velocity ?? 0;
  let t = 0;
  let peak = 0;
  let settledFor = 0;
  const samples: { t: number; x: number }[] = [{ t: 0, x: 0 }];
  const maxT = 3; // segundos

  while (t < maxT) {
    // Euler semiimplícito: estable con pasos de 1 ms.
    const force = -config.stiffness * (x - 1) - config.damping * v;
    v += (force / mass) * dt;
    x += v * dt;
    t += dt;
    peak = Math.max(peak, x);
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) {
      settledFor += dt;
      if (settledFor > 0.03) break;
    } else {
      settledFor = 0;
    }
    if (Math.round(t * 1000) % 8 === 0) samples.push({ t, x });
  }
  samples.push({ t, x: 1 });

  // Reduce puntos redundantes (tramos casi rectos) para una curva compacta.
  const points: { t: number; x: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i] as { t: number; x: number };
    const prev = points[points.length - 1];
    const next = samples[i + 1];
    if (prev && next) {
      const expected = prev.x + ((next.x - prev.x) * (p.t - prev.t)) / (next.t - prev.t);
      if (Math.abs(expected - p.x) < 0.0015) continue;
    }
    points.push(p);
  }

  const total = t;
  const stops = points.map((p, i) => {
    if (i === 0) return '0';
    if (i === points.length - 1) return '1';
    return `${p.x.toFixed(4)} ${((p.t / total) * 100).toFixed(2)}%`;
  });
  const curve: SpringCurve = { easing: `linear(${stops.join(', ')})`, duration: Math.round(total * 1000), peak };
  cache.set(key, curve);
  return curve;
}

/** Muelles con nombre usados en toda la interfaz. */
export const SPRINGS = {
  /** Apertura de la rueda: rebote pequeño y controlado. */
  open: { stiffness: 420, damping: 25 },
  /** La esfera central se asienta con algo más de rebote. */
  settle: { stiffness: 300, damping: 17 },
  /** Pétalos al aparecer. */
  petal: { stiffness: 520, damping: 28 },
  /** Respuesta al cursor: rápida y sin oscilar. */
  hover: { stiffness: 700, damping: 40 },
  /** Notificación. */
  toast: { stiffness: 380, damping: 24 },
} satisfies Record<string, SpringConfig>;

export const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Publica los muelles como variables CSS para usarlos en transiciones declarativas. */
export function installSpringVariables(root: HTMLElement = document.documentElement): void {
  for (const [name, config] of Object.entries(SPRINGS)) {
    const curve = spring(config);
    root.style.setProperty(`--spring-${name}`, curve.easing);
    root.style.setProperty(`--spring-${name}-duration`, `${curve.duration}ms`);
  }
}
