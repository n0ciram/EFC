/**
 * Ajuste de nombres largos dentro del círculo central sin deformarlo: se reparte el nombre en
 * líneas medidas con la fuente real y, si no cabe, se acorta por el centro conservando la extensión.
 */

let canvas: HTMLCanvasElement | null = null;

function measurer(font: string): CanvasRenderingContext2D | null {
  canvas ??= document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.font = font;
  return ctx;
}

function width(ctx: CanvasRenderingContext2D | null, text: string): number {
  return ctx ? ctx.measureText(text).width : text.length * 6.5;
}

/** Acorta por el centro hasta que `text` quepa en `maxWidth`, manteniendo la extensión visible. */
export function middleEllipsis(text: string, maxWidth: number, font: string): string {
  const ctx = measurer(font);
  if (width(ctx, text) <= maxWidth) return text;
  const dot = text.lastIndexOf('.');
  const ext = dot > 0 && text.length - dot <= 6 ? text.slice(dot) : '';
  const stem = ext ? text.slice(0, dot) : text;
  let lo = 0;
  let hi = stem.length;
  let best = `…${ext}`;
  while (lo <= hi) {
    const keep = Math.floor((lo + hi) / 2);
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    const candidate = `${stem.slice(0, head).trimEnd()}…${tail > 0 ? stem.slice(stem.length - tail).trimStart() : ''}${ext}`;
    if (width(ctx, candidate) <= maxWidth) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}

/**
 * Reparte un nombre en un máximo de `maxLines` líneas que caben en `lineWidths` (una anchura por línea,
 * porque en un círculo las líneas superior e inferior son más cortas). La última línea se acorta por
 * el centro si hace falta.
 */
export function fitLines(text: string, lineWidths: readonly number[], font: string): string[] {
  const ctx = measurer(font);
  const lines: string[] = [];
  let rest = text;
  // No se separa la extensión del nombre («logo-empresa.png» → «logo-» / «empresa.png»).
  const extDot = text.lastIndexOf('.');
  const keepExtension = extDot > 0 && text.length - extDot <= 6;
  let consumed = 0;
  for (let i = 0; i < lineWidths.length && rest.length > 0; i++) {
    const maxWidth = lineWidths[i] as number;
    const isLast = i === lineWidths.length - 1;
    if (width(ctx, rest) <= maxWidth) {
      lines.push(rest);
      rest = '';
      break;
    }
    if (isLast) {
      lines.push(middleEllipsis(rest, maxWidth, font));
      rest = '';
      break;
    }
    // Corta por el último separador natural que quepa; si no hay, por carácter.
    let cut = 0;
    for (let n = 1; n <= rest.length; n++) {
      if (width(ctx, rest.slice(0, n)) > maxWidth) break;
      cut = n;
    }
    const slice = rest.slice(0, cut);
    let breakAt = -1;
    for (let k = slice.length - 1; k >= 0; k--) {
      const ch = slice[k];
      if (ch !== ' ' && ch !== '-' && ch !== '_' && ch !== '.') continue;
      if (keepExtension && ch === '.' && consumed + k === extDot) continue;
      breakAt = k;
      break;
    }
    const end = breakAt > cut * 0.15 ? breakAt + 1 : Math.max(1, cut);
    lines.push(rest.slice(0, end).trimEnd());
    consumed += end;
    const trimmed = rest.slice(end).trimStart();
    consumed += rest.length - end - trimmed.length;
    rest = trimmed;
  }
  return lines;
}
