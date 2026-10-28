/**
 * Traducción entre la configuración (config.json) y la ventana de ajustes, sin dependencias de
 * Electron. Cada cambio que llega de la interfaz se valida aquí antes de tocar la configuración.
 */
import { PDF_DPI_CHOICES, PHOTO_SIZE_CHOICES, QUALITY_PRESETS, VIDEO_SIZE_CHOICES, type Choice } from '../../src/lib/settings-options';
import type { ImageQuality, SettingsChange, SettingsValues } from '../../src/types/ipc';
import { MOD_ALT, MOD_CTRL, MOD_WIN, parseAccelerator } from '../windows/shortcut';
import { isLanguage, type Messages } from '../../src/i18n';
import { es } from '../../src/i18n/es';
import type { AppConfig } from './config';

/** Nivel de calidad que corresponde a la configuración (o `custom` si se editó a mano). */
export function imageQualityOf(conversion: AppConfig['conversion']): ImageQuality {
  for (const [level, preset] of Object.entries(QUALITY_PRESETS) as [Exclude<ImageQuality, 'custom'>, (typeof QUALITY_PRESETS)['max']][]) {
    if (preset.jpegQuality === conversion.jpegQuality && preset.webpQuality === conversion.webpQuality && preset.avifQuality === conversion.avifQuality) {
      return level;
    }
  }
  return 'custom';
}

export function settingsValues(config: AppConfig): SettingsValues {
  return {
    shortcut: config.shortcut,
    launchAtLogin: config.launchAtLogin,
    contextMenu: config.contextMenu,
    language: config.language,
    backdropBlur: config.backdropBlur,
    wheelTransparency: config.wheelTransparency,
    excludeFromScreenCapture: config.excludeFromScreenCapture,
    imageQuality: imageQualityOf(config.conversion),
    pdfDpi: config.conversion.pdfDpi,
    shrinkMaxSide: config.conversion.shrinkMaxSide,
    shrinkVideoMaxSide: config.conversion.shrinkVideoMaxSide,
  };
}

/**
 * Comprueba un atajo nuevo. Debe llevar Ctrl, Alt o Win (con Mayús sola se perdería esa letra al
 * escribir), salvo las teclas de función, que pueden ir solas. Devuelve el motivo si no vale.
 */
export function shortcutProblem(accelerator: string, m: Messages = es): string | null {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return m.settings.errors.key;
  const isFunctionKey = parsed.vk >= 0x70 && parsed.vk <= 0x87;
  if (!isFunctionKey && (parsed.mods & (MOD_CTRL | MOD_ALT | MOD_WIN)) === 0) return m.settings.errors.modifier;
  return null;
}

const oneOf = (value: unknown, choices: readonly Choice<number>[]): value is number => choices.some((c) => c.value === value);

export type SettingsPatch = { ok: true; patch: Partial<AppConfig> } | { ok: false; message: string };

/** Convierte un cambio de la interfaz en los cambios de configuración que supone (o lo rechaza). */
export function patchFor(config: AppConfig, change: SettingsChange, m: Messages = es): SettingsPatch {
  const reject = (message: string = m.settings.errors.invalid): SettingsPatch => ({ ok: false, message });
  const conversion = (patch: Partial<AppConfig['conversion']>): SettingsPatch => ({
    ok: true,
    patch: { conversion: { ...config.conversion, ...patch } },
  });
  const { key, value } = change;
  switch (key) {
    case 'shortcut': {
      if (typeof value !== 'string') return reject();
      const problem = shortcutProblem(value, m);
      return problem ? reject(problem) : { ok: true, patch: { shortcut: value } };
    }
    case 'launchAtLogin':
    case 'contextMenu':
    case 'backdropBlur':
    case 'excludeFromScreenCapture':
      return typeof value === 'boolean' ? { ok: true, patch: { [key]: value } } : reject();
    case 'language':
      return isLanguage(value) ? { ok: true, patch: { language: value } } : reject();
    case 'wheelTransparency':
      return typeof value === 'number' && Number.isFinite(value)
        ? {
            ok: true,
            patch: {
              wheelTransparency: Math.min(100, Math.max(0, Math.round(value))),
            },
          }
        : reject();
    case 'imageQuality':
      return value !== 'custom' && typeof value === 'string' && value in QUALITY_PRESETS
        ? conversion(QUALITY_PRESETS[value as keyof typeof QUALITY_PRESETS])
        : reject();
    case 'pdfDpi':
      return oneOf(value, PDF_DPI_CHOICES) ? conversion({ pdfDpi: value }) : reject();
    case 'shrinkMaxSide':
      return oneOf(value, PHOTO_SIZE_CHOICES) ? conversion({ shrinkMaxSide: value }) : reject();
    case 'shrinkVideoMaxSide':
      return oneOf(value, VIDEO_SIZE_CHOICES) ? conversion({ shrinkVideoMaxSide: value }) : reject();
    default:
      return reject();
  }
}
