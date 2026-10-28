/**
 * Coreografía de la rueda con la Web Animations API.
 *
 * - Apertura: el cristal crece desde un círculo pequeño bajo el cursor con un rebote controlado, el
 *   desenfoque del fondo aumenta progresivamente, los pétalos aparecen escalonados en sentido horario
 *   y la esfera central se asienta con un pequeño rebote propio.
 * - Cierre: contracción rápida con desvanecimiento coherente.
 * - Elección: el pétalo elegido late y la rueda se recoge hacia el centro.
 *
 * Solo se animan `transform`, `opacity`, `filter` y `clip-path` de elementos pequeños.
 * Con «reducir animaciones» activado en Windows todo se limita a fundidos breves.
 */
import { EASE_IN, EASE_OUT, spring, SPRINGS } from './spring';

export interface WheelParts {
  shadow: HTMLElement;
  glass: HTMLElement;
  backdrop: HTMLElement | null;
  rim: HTMLElement;
  body: HTMLElement;
  petals: HTMLElement[];
  orb: HTMLElement;
  notice: HTMLElement | null;
}

/** La rueda aparece desde un tamaño ligeramente inferior al final. */
const START_SCALE = 0.8;

function cancelAll(elements: (Element | null)[]): void {
  for (const el of elements) {
    if (!el) continue;
    for (const animation of el.getAnimations()) animation.cancel();
  }
}

function allParts(p: WheelParts): (HTMLElement | null)[] {
  // Incluye el escenario (padre del cuerpo), que recibe los fundidos de apertura y cierre.
  return [p.body.parentElement, p.shadow, p.glass, p.backdrop, p.rim, p.body, p.orb, p.notice, ...p.petals];
}

function finished(animations: Animation[]): Promise<void> {
  return Promise.all(animations.map((a) => a.finished.catch(() => undefined))).then(() => undefined);
}

export function resetWheel(parts: WheelParts): void {
  cancelAll(allParts(parts));
}

export function animateOpen(parts: WheelParts, radius: number, reduced: boolean): Promise<void> {
  cancelAll(allParts(parts));
  if (reduced) {
    return finished([parts.body.parentElement?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, easing: 'linear', fill: 'backwards' })].filter(Boolean) as Animation[]);
  }
  const pop = spring(SPRINGS.open);
  const settle = spring(SPRINGS.settle);
  const petal = spring(SPRINGS.petal);
  const startRadius = radius * START_SCALE;
  const animations: Animation[] = [];

  animations.push(
    parts.glass.animate([{ clipPath: `circle(${startRadius}px at 50% 50%)` }, { clipPath: `circle(${radius}px at 50% 50%)` }], {
      duration: pop.duration,
      easing: pop.easing,
      fill: 'backwards',
    }),
  );
  // La opacidad sube rápido y de forma lineal; la escala sigue el muelle.
  const root = parts.body.parentElement;
  if (root) animations.push(root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 130, easing: EASE_OUT, fill: 'backwards' }));
  for (const el of [parts.rim, parts.body]) {
    animations.push(el.animate([{ transform: `scale(${START_SCALE})` }, { transform: 'scale(1)' }], { duration: pop.duration, easing: pop.easing, fill: 'backwards' }));
  }
  animations.push(
    parts.shadow.animate([{ transform: `scale(${START_SCALE})`, opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: pop.duration, easing: pop.easing, fill: 'backwards' }),
  );
  if (parts.backdrop) {
    animations.push(
      parts.backdrop.animate(
        [
          { filter: 'blur(3px) saturate(1.05)', opacity: 0.4 },
          { filter: 'blur(18px) saturate(1.25)', opacity: 1 },
        ],
        { duration: 300, easing: EASE_OUT, fill: 'backwards' },
      ),
    );
  }
  parts.petals.forEach((el, i) => {
    animations.push(
      el.animate(
        [
          { opacity: 0, transform: 'scale(0.82) rotate(-6deg)' },
          { opacity: 1, transform: 'scale(1) rotate(0deg)' },
        ],
        { duration: petal.duration, easing: petal.easing, delay: 40 + i * 18, fill: 'backwards' },
      ),
    );
  });
  animations.push(
    parts.orb.animate([{ opacity: 0, transform: 'scale(0.45)' }, { opacity: 1, transform: 'scale(1)' }], {
      duration: settle.duration,
      easing: settle.easing,
      delay: 30,
      fill: 'backwards',
    }),
  );
  if (parts.notice) {
    animations.push(parts.notice.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 160, easing: EASE_OUT, fill: 'backwards' }));
  }
  return finished(animations);
}

export function animateClose(parts: WheelParts, radius: number, reduced: boolean): Promise<void> {
  cancelAll(allParts(parts));
  const options: KeyframeAnimationOptions = { duration: reduced ? 80 : 150, easing: EASE_IN, fill: 'forwards' };
  const animations: Animation[] = [];
  if (reduced) {
    const root = parts.body.parentElement;
    if (root) animations.push(root.animate([{ opacity: 1 }, { opacity: 0 }], options));
    return finished(animations);
  }
  for (const el of [parts.rim, parts.body, parts.shadow]) {
    animations.push(el.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.86)', opacity: 0 }], options));
  }
  animations.push(parts.glass.animate([{ clipPath: `circle(${radius}px at 50% 50%)`, opacity: 1 }, { clipPath: `circle(${radius * 0.86}px at 50% 50%)`, opacity: 0 }], options));
  if (parts.notice) animations.push(parts.notice.animate([{ opacity: 1 }, { opacity: 0 }], { ...options, duration: 100 }));
  return finished(animations);
}

export function animateCommit(parts: WheelParts, radius: number, chosen: number, reduced: boolean): Promise<void> {
  if (reduced) return animateClose(parts, radius, true);
  // Se parte de la transformación actual (incluye el desplazamiento de «hover») para evitar saltos.
  const current = (el: HTMLElement): string => {
    const t = getComputedStyle(el).transform;
    return t && t !== 'none' ? `${t} ` : '';
  };
  const chosenPetal = parts.petals[chosen];
  const animations: Animation[] = [];
  if (chosenPetal) {
    const base = current(chosenPetal);
    animations.push(
      chosenPetal.animate(
        [
          { transform: `${base}scale(1)`, filter: 'brightness(1)' },
          { transform: `${base}scale(1.06)`, filter: 'brightness(1.12)', offset: 0.35 },
          { transform: `${base}scale(0.5)`, opacity: 0, filter: 'brightness(1)' },
        ],
        { duration: 300, easing: 'cubic-bezier(0.3, 0, 0.6, 1)', fill: 'forwards' },
      ),
    );
  }
  parts.petals.forEach((el, i) => {
    if (i === chosen) return;
    const base = current(el);
    animations.push(el.animate([{ opacity: 1, transform: `${base}scale(1)` }, { opacity: 0, transform: `${base}scale(0.7)` }], { duration: 160, easing: EASE_IN, fill: 'forwards' }));
  });
  const collapse: KeyframeAnimationOptions = { duration: 230, delay: 90, easing: EASE_IN, fill: 'forwards' };
  animations.push(parts.orb.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.55)', opacity: 0 }], collapse));
  for (const el of [parts.rim, parts.shadow]) {
    animations.push(el.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.3)', opacity: 0 }], collapse));
  }
  animations.push(parts.glass.animate([{ clipPath: `circle(${radius}px at 50% 50%)`, opacity: 1 }, { clipPath: `circle(${radius * 0.3}px at 50% 50%)`, opacity: 0 }], collapse));
  if (parts.notice) animations.push(parts.notice.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: 'forwards' }));
  return finished(animations);
}

/** Salida de los pétalos al cambiar de página (`direction` 1 = adelante). */
export function animatePetalsOut(petals: HTMLElement[], direction: 1 | -1, reduced: boolean): Promise<void> {
  const animations = petals.map((el) =>
    el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: reduced ? 'none' : `rotate(${-16 * direction}deg) scale(0.92)` },
      ],
      { duration: reduced ? 70 : 110, easing: EASE_IN, fill: 'forwards' },
    ),
  );
  return finished(animations);
}

/** Entrada de los pétalos de la nueva página. */
export function animatePetalsIn(petals: HTMLElement[], direction: 1 | -1, reduced: boolean): Promise<void> {
  cancelAll(petals);
  const petal = spring(SPRINGS.petal);
  const animations = petals.map((el, i) =>
    el.animate(
      [
        { opacity: 0, transform: reduced ? 'none' : `rotate(${16 * direction}deg) scale(0.92)` },
        { opacity: 1, transform: 'none' },
      ],
      reduced ? { duration: 90, easing: 'linear', fill: 'backwards' } : { duration: petal.duration, easing: petal.easing, delay: i * 16, fill: 'backwards' },
    ),
  );
  return finished(animations);
}

/** Pequeño latido al confirmar con el teclado o al repetir una conversión en curso. */
export function pulse(el: HTMLElement): void {
  const curve = spring(SPRINGS.hover);
  el.animate([{ transform: 'scale(0.97)' }, { transform: 'scale(1)' }], { duration: curve.duration, easing: curve.easing });
}
