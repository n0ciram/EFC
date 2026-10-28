/**
 * Entrada «Convertir con EFC» en el menú del botón derecho del Explorador.
 *
 * - Se registra solo para el usuario actual (HKCU, sin permisos de administrador) y solo para las
 *   extensiones que EFC sabe convertir (SystemFileAssociations\.ext\shell), de modo que no aparece
 *   en archivos que no podría tratar.
 * - La orden ejecuta el lanzador nativo (efc-helper.exe --open "%1"), que avisa a EFC al instante.
 * - «MultiSelectModel = Player» permite seleccionar hasta 100 archivos (con el valor por defecto, el
 *   Explorador oculta la entrada a partir de 15).
 * - En Windows 11 las entradas clásicas aparecen en «Mostrar más opciones» (o Mayús + clic derecho):
 *   el menú compacto solo admite aplicaciones empaquetadas y firmadas.
 *
 * Se aplica importando un archivo .reg con reg.exe (un único proceso, sin intérprete de comandos).
 * El desinstalador borra las mismas claves (resources/build/installer.nsh).
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FormatId } from '../../src/types/formats';
import { FORMATS } from '../conversion/formats';
import { officeAppFor, type OfficeApps } from '../conversion/registry';

export const MENU_VERB = 'EFC.Convert';

/** Formatos que no se pueden convertir desde el Explorador (no son origen de ninguna conversión). */
const NOT_SOURCES: ReadonlySet<FormatId> = new Set<FormatId>(['ico', 'heic']);

const ALL_OFFICE: OfficeApps = { word: true, excel: true, powerpoint: true };

/**
 * Extensiones (sin punto, en minúsculas) en las que aparece la entrada. Los documentos de Office solo
 * si su aplicación está instalada (sin ella, EFC no podría convertirlos).
 */
export function menuExtensions(office: OfficeApps | null): string[] {
  const list = new Set<string>();
  for (const info of Object.values(FORMATS)) {
    if (NOT_SOURCES.has(info.id)) continue;
    const app = officeAppFor(info.id);
    if (app && !office?.[app]) continue;
    for (const ext of info.extensions) list.add(ext.toLowerCase());
  }
  return [...list].sort();
}

/** Todas las extensiones en las que puede llegar a aparecer (las que retira el desinstalador). */
export function allMenuExtensions(): string[] {
  return menuExtensions(ALL_OFFICE);
}

const regString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const keyFor = (ext: string): string => `HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.${ext}\\shell\\${MENU_VERB}`;

/**
 * Contenido del archivo .reg. Siempre borra primero las claves de `previous` y de las actuales (por si
 * cambió la lista de extensiones o la ruta del programa) y, si `register`, las vuelve a crear.
 */
export function registryScript(options: {
  register: boolean;
  helperExe: string;
  iconExe: string;
  extensions: readonly string[];
  /** Texto de la entrada en el idioma de la interfaz («Convertir con EFC», «Convert with EFC»). */
  text: string;
  previous?: readonly string[];
}): string {
  const current = options.extensions;
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const ext of [...new Set([...(options.previous ?? []), ...current])].sort()) {
    lines.push(`[-${keyFor(ext)}]`, '');
  }
  if (options.register) {
    const command = `"${options.helperExe}" --open "%1"`;
    for (const ext of current) {
      lines.push(
        `[${keyFor(ext)}]`,
        `@=${regString(options.text)}`,
        `"MUIVerb"=${regString(options.text)}`,
        `"Icon"=${regString(`${options.iconExe},0`)}`,
        `"MultiSelectModel"="Player"`,
        '',
        `[${keyFor(ext)}\\command]`,
        `@=${regString(command)}`,
        '',
      );
    }
  }
  return lines.join('\r\n');
}

/** Identifica el registro aplicado; si cambia (versión, ruta, extensiones o idioma), se vuelve a aplicar. */
export function registrationMarker(version: string, helperExe: string, extensions: readonly string[], language: string): string {
  return `${version}|${helperExe.toLowerCase()}|${extensions.join(',')}|${language}`;
}

export function extensionsFromMarker(marker: string): string[] {
  return (marker.split('|')[2] ?? '').split(',').filter((e) => /^[a-z0-9]{1,8}$/.test(e));
}

/** Importa el script con reg.exe. Los .reg con acentos deben ir en UTF-16 LE con BOM. */
export async function importRegistry(script: string): Promise<void> {
  const file = path.join(os.tmpdir(), `efc-menu-${process.pid}-${Date.now()}.reg`);
  await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]));
  try {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const reg = path.join(systemRoot, 'System32', 'reg.exe');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(reg, ['import', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`reg import terminó con código ${code}: ${stderr.trim()}`))));
    });
  } finally {
    await fs.rm(file, { force: true });
  }
}
