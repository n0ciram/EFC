/**
 * En la aplicación empaquetada, los módulos nativos, los binarios y sus datos se extraen a
 * `app.asar.unpacked` porque no pueden ejecutarse ni leerse por rutas reales desde dentro del archivo asar.
 */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
