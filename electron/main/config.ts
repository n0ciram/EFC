/**
 * Configuración persistente en `%APPDATA%\EFC\config.json`. Cualquier valor ausente o no válido se
 * sustituye por el predeterminado, de modo que un archivo editado a mano nunca impide arrancar.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../../src/i18n';
import { DEFAULT_WHEEL_TRANSPARENCY } from '../../src/lib/settings-options';
import { DEFAULT_CONVERSION_SETTINGS, sanitizeConversionSettings, type ConversionSettings } from '../conversion/settings';
import { createLogger } from './logger';

const log = createLogger('config');

export interface AppConfig {
  /** Atajo global (formato de acelerador de Electron). */
  shortcut: string;
  /** Iniciar EFC al iniciar sesión en Windows. */
  launchAtLogin: boolean;
  /** Mostrar el icono en el área de notificación (para salir o cambiar opciones). */
  trayIcon: boolean;
  /** Desenfocar el escritorio real detrás de la rueda (captura local, nunca se guarda ni se envía). */
  backdropBlur: boolean;
  /** Transparencia del cristal de la rueda: 0 más opaca, 50 la original, 100 más transparente. */
  wheelTransparency: number;
  /** Idioma de la interfaz. */
  language: Language;
  /** Interno: elección del instalador ya aplicada (para no repetirla en cada arranque). */
  installerLanguageApplied: string;
  /**
   * Ocultar la rueda y los avisos en capturas de pantalla y grabaciones (Windows 10 2004 o posterior).
   * Hace que el desenfoque muestre solo lo que hay detrás; desactívalo si quieres grabar EFC en vídeo.
   */
  excludeFromScreenCapture: boolean;
  /** Si el atajo se pulsa fuera del Explorador, reenviarlo a la aplicación activa. */
  passThroughShortcut: boolean;
  /** Entrada «Convertir con EFC» en el menú del botón derecho del Explorador. */
  contextMenu: boolean;
  /** Ruta a un FFmpeg concreto; `null` para usar el incluido o el del PATH. */
  ffmpegPath: string | null;
  /** Conversiones simultáneas como máximo. */
  maxConcurrentJobs: number;
  /** Registro detallado para diagnóstico. */
  verboseLog: boolean;
  conversion: ConversionSettings;
  /** Interno: ya se mostró el aviso de bienvenida. */
  welcomeShown: boolean;
  /** Interno: registro del menú contextual aplicado (versión, ruta y extensiones). */
  contextMenuApplied: string;
}

export const DEFAULT_CONFIG: Readonly<AppConfig> = {
  shortcut: 'CommandOrControl+Shift+E',
  launchAtLogin: true,
  trayIcon: true,
  backdropBlur: true,
  wheelTransparency: DEFAULT_WHEEL_TRANSPARENCY,
  language: DEFAULT_LANGUAGE,
  excludeFromScreenCapture: true,
  passThroughShortcut: true,
  contextMenu: true,
  ffmpegPath: null,
  maxConcurrentJobs: 2,
  verboseLog: false,
  conversion: { ...DEFAULT_CONVERSION_SETTINGS },
  welcomeShown: false,
  contextMenuApplied: '',
  installerLanguageApplied: '',
};

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);

/** `defaults.language`: idioma si config.json no dice nada (el de Windows en la primera ejecución). */
export function sanitizeConfig(raw: unknown, defaults: { language?: Language } = {}): AppConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CONFIG;
  const shortcut = typeof input.shortcut === 'string' && /^[A-Za-z0-9+ ]{2,60}$/.test(input.shortcut) ? input.shortcut : d.shortcut;
  const ffmpegPath = typeof input.ffmpegPath === 'string' && input.ffmpegPath.trim().length > 0 ? input.ffmpegPath.trim() : null;
  const jobs = typeof input.maxConcurrentJobs === 'number' && Number.isFinite(input.maxConcurrentJobs) ? Math.round(input.maxConcurrentJobs) : d.maxConcurrentJobs;
  return {
    shortcut,
    launchAtLogin: bool(input.launchAtLogin, d.launchAtLogin),
    trayIcon: bool(input.trayIcon, d.trayIcon),
    backdropBlur: bool(input.backdropBlur, d.backdropBlur),
    wheelTransparency:
      typeof input.wheelTransparency === 'number' && Number.isFinite(input.wheelTransparency)
        ? Math.min(100, Math.max(0, Math.round(input.wheelTransparency)))
        : d.wheelTransparency,
    language: isLanguage(input.language) ? input.language : (defaults.language ?? d.language),
    excludeFromScreenCapture: bool(input.excludeFromScreenCapture, d.excludeFromScreenCapture),
    passThroughShortcut: bool(input.passThroughShortcut, d.passThroughShortcut),
    contextMenu: bool(input.contextMenu, d.contextMenu),
    ffmpegPath,
    maxConcurrentJobs: Math.min(4, Math.max(1, jobs)),
    verboseLog: bool(input.verboseLog, d.verboseLog),
    conversion: sanitizeConversionSettings(input.conversion as Record<string, unknown> | undefined),
    welcomeShown: bool(input.welcomeShown, d.welcomeShown),
    contextMenuApplied: typeof input.contextMenuApplied === 'string' ? input.contextMenuApplied.slice(0, 4000) : d.contextMenuApplied,
    installerLanguageApplied: typeof input.installerLanguageApplied === 'string' ? input.installerLanguageApplied.slice(0, 200) : d.installerLanguageApplied,
  };
}

export class ConfigStore {
  private current: AppConfig;
  readonly file: string;

  /** `defaults.language`: idioma para un config.json sin idioma (primera ejecución). */
  constructor(
    dir: string,
    private readonly defaults: { language?: Language } = {},
  ) {
    this.file = path.join(dir, 'config.json');
    this.current = this.load();
  }

  get value(): AppConfig {
    return this.current;
  }

  private load(): AppConfig {
    try {
      const text = readFileSync(this.file, 'utf8').replace(/^﻿/, '');
      return sanitizeConfig(JSON.parse(text), this.defaults);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('config.json no válido; se usan valores predeterminados', err);
      const config = sanitizeConfig({}, this.defaults);
      this.write(config);
      return config;
    }
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.current = sanitizeConfig({ ...this.current, ...patch });
    this.write(this.current);
    return this.current;
  }

  reload(): AppConfig {
    this.current = this.load();
    return this.current;
  }

  private write(config: AppConfig): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn('No se pudo guardar config.json', err);
    }
  }
}
