/**
 * Atajo global (por defecto Ctrl + Mayús + E).
 *
 * Electron registra el atajo con `RegisterHotKey`, lo que lo «captura» en todo el sistema. Para no
 * romper el mismo atajo en otras aplicaciones (en Word activa el control de cambios, en VS Code abre
 * el explorador…), cuando la ventana activa no es el Explorador EFC lo reenvía: libera el atajo,
 * lo inyecta en la aplicación activa y vuelve a registrarlo.
 */
import type { Messages } from '../../src/i18n';
import { es } from '../../src/i18n/es';
import { createLogger } from '../main/logger';

const log = createLogger('atajo');

export const MOD_CTRL = 1;
export const MOD_SHIFT = 2;
export const MOD_ALT = 4;
export const MOD_WIN = 8;

export interface ParsedAccelerator {
  /** Código de tecla virtual de Windows. */
  vk: number;
  /** Máscara de modificadores (1 Ctrl, 2 Mayús, 4 Alt, 8 Win). */
  mods: number;
  /** Texto legible en el idioma de la interfaz, p. ej. «Ctrl + Mayús + E» o «Ctrl + Shift + E». */
  label: string;
}

/** Interpreta un acelerador de Electron. Devuelve `null` si la tecla no se puede reenviar. */
export function parseAccelerator(accelerator: string, keys: Messages['keys'] = es.keys): ParsedAccelerator | null {
  const tokens = accelerator.split('+').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  let mods = 0;
  let vk = 0;
  let keyLabel = '';
  for (const token of tokens) {
    const t = token.toLowerCase();
    if (['commandorcontrol', 'cmdorctrl', 'control', 'ctrl'].includes(t)) mods |= MOD_CTRL;
    else if (t === 'shift') mods |= MOD_SHIFT;
    else if (t === 'alt' || t === 'option') mods |= MOD_ALT;
    else if (t === 'super' || t === 'meta') mods |= MOD_WIN;
    else {
      if (vk !== 0) return null;
      if (/^[a-z]$/.test(t)) {
        vk = t.toUpperCase().charCodeAt(0);
        keyLabel = t.toUpperCase();
      } else if (/^[0-9]$/.test(t)) {
        vk = 0x30 + Number(t);
        keyLabel = t;
      } else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) {
        vk = 0x70 + Number(t.slice(1)) - 1;
        keyLabel = t.toUpperCase();
      } else if (t === 'space') {
        vk = 0x20;
        keyLabel = keys.space;
      } else {
        return null;
      }
    }
  }
  if (vk === 0) return null;
  const names: string[] = [];
  if (mods & MOD_CTRL) names.push(keys.ctrl);
  if (mods & MOD_SHIFT) names.push(keys.shift);
  if (mods & MOD_ALT) names.push(keys.alt);
  if (mods & MOD_WIN) names.push(keys.win);
  names.push(keyLabel);
  return { vk, mods, label: names.join(' + ') };
}

export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

export class GlobalShortcut {
  private registered = false;
  private reRegisterTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly accelerator: string,
    private readonly onTrigger: () => void,
    private readonly registrar: ShortcutRegistrar,
  ) {}

  register(): boolean {
    if (this.registered && this.registrar.isRegistered(this.accelerator)) return true;
    try {
      this.registered = this.registrar.register(this.accelerator, this.onTrigger);
    } catch (err) {
      log.error(`Acelerador no válido: ${this.accelerator}`, err);
      this.registered = false;
    }
    if (!this.registered) log.error(`No se pudo registrar el atajo ${this.accelerator} (¿lo usa otra aplicación?)`);
    return this.registered;
  }

  unregister(): void {
    if (this.reRegisterTimer) {
      clearTimeout(this.reRegisterTimer);
      this.reRegisterTimer = null;
    }
    if (this.registered) {
      try {
        this.registrar.unregister(this.accelerator);
      } catch {
        // ya liberado
      }
    }
    this.registered = false;
  }

  /**
   * Reenvía el atajo a la aplicación activa: lo libera, ejecuta `inject` y lo vuelve a registrar
   * poco después (el tiempo justo para que Windows procese la pulsación inyectada).
   */
  async passThrough(inject: () => Promise<void>): Promise<void> {
    this.unregister();
    try {
      await inject();
    } catch (err) {
      log.warn('No se pudo reenviar el atajo', err);
    } finally {
      this.reRegisterTimer = setTimeout(() => {
        this.reRegisterTimer = null;
        this.register();
      }, 80);
    }
  }
}
