/**
 * Grabación de un atajo nuevo en la ventana de ajustes: convierte una pulsación de teclado en un
 * acelerador de Electron («CommandOrControl+Shift+E») y en su texto legible en el idioma de la
 * interfaz («Ctrl + Mayús + E» o «Ctrl + Shift + E»).
 */
import type { Messages } from '../i18n';
import { es } from '../i18n/es';

export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type KeyResult =
  /** Solo modificadores pulsados por ahora: se muestran mientras se espera la tecla principal. */
  | { kind: 'pending'; label: string }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; accelerator: string; label: string };

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

function modifierNames(e: KeyPress, keys: Messages['keys']): { accel: string[]; label: string[] } {
  const accel: string[] = [];
  const label: string[] = [];
  if (e.ctrlKey) {
    accel.push('CommandOrControl');
    label.push(keys.ctrl);
  }
  if (e.shiftKey) {
    accel.push('Shift');
    label.push(keys.shift);
  }
  if (e.altKey) {
    accel.push('Alt');
    label.push(keys.alt);
  }
  if (e.metaKey) {
    accel.push('Super');
    label.push(keys.win);
  }
  return { accel, label };
}

/** Tecla principal admitida (la misma lista que entiende el proceso principal). */
function mainKey(code: string, keys: Messages['keys']): { accel: string; label: string; functionKey: boolean } | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return { accel: m[1] as string, label: m[1] as string, functionKey: false };
  m = /^Digit([0-9])$/.exec(code);
  if (m) return { accel: m[1] as string, label: m[1] as string, functionKey: false };
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return { accel: `F${m[1]}`, label: `F${m[1]}`, functionKey: true };
  if (code === 'Space') return { accel: 'Space', label: keys.space, functionKey: false };
  return null;
}

export function keyToShortcut(e: KeyPress, m: Messages = es): KeyResult {
  const mods = modifierNames(e, m.keys);
  if (MODIFIER_CODES.has(e.code)) return { kind: 'pending', label: [...mods.label, '…'].join(' + ') };
  const key = mainKey(e.code, m.keys);
  if (!key) return { kind: 'invalid', message: m.settings.errors.key };
  if (!key.functionKey && !e.ctrlKey && !e.altKey && !e.metaKey) return { kind: 'invalid', message: m.settings.errors.modifier };
  return { kind: 'ok', accelerator: [...mods.accel, key.accel].join('+'), label: [...mods.label, key.label].join(' + ') };
}
