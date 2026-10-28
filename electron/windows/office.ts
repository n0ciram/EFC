/**
 * Detección de Microsoft Office: qué aplicaciones se pueden automatizar (Word, Excel y PowerPoint).
 *
 * Se mira si su clase de automatización está registrada (HKEY_CLASSES_ROOT\<App>.Application\CLSID)
 * con reg.exe, sin abrir Office. Si después Office no llegase a arrancar, el aviso de error lo dirá.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { OfficeApp, OfficeApps } from '../conversion/registry';

const PROG_IDS: Readonly<Record<OfficeApp, string>> = {
  word: 'Word.Application',
  excel: 'Excel.Application',
  powerpoint: 'PowerPoint.Application',
};

function keyExists(key: string): Promise<boolean> {
  const reg = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve) => {
    const child = spawn(reg, ['query', key, '/ve'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** Aplicaciones de Office instaladas, o `null` si no hay ninguna (o no es Windows). */
export async function detectOffice(): Promise<OfficeApps | null> {
  if (process.platform !== 'win32') return null;
  const apps = Object.keys(PROG_IDS) as OfficeApp[];
  const found = await Promise.all(apps.map((app) => keyExists(`HKCR\\${PROG_IDS[app]}\\CLSID`)));
  if (!found.some(Boolean)) return null;
  return { word: found[0] === true, excel: found[1] === true, powerpoint: found[2] === true };
}
