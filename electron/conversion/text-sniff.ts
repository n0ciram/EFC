/**
 * Reconocimiento de texto sin formato por contenido (sin dependencias: lo usa también el proceso principal).
 */

/** Bytes de control que no aparecen en un texto normal (se permiten el tabulador y los saltos de línea y de página). */
function isBinaryControl(b: number): boolean {
  return (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) || b === 0x7f;
}

/** ¿El contenido parece texto? Se usa en la detección cuando la extensión es de texto. */
export function looksLikeText(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return true;
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return true; // UTF-16 con BOM
  let control = 0;
  for (const b of buf) {
    if (b === 0) return false;
    if (isBinaryControl(b)) control++;
  }
  return control <= Math.max(2, buf.length * 0.01);
}
