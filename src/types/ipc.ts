/**
 * Contrato de comunicación entre el proceso principal (Electron) y la interfaz (React).
 *
 * Principios de seguridad:
 * - La interfaz nunca recibe rutas completas de archivos: solo nombres para mostrar.
 * - La interfaz nunca envía rutas: solo identificadores de destino que el proceso
 *   principal valida contra la lista que él mismo ofreció.
 */
import type { Language } from '../i18n';
import type { IconId, TargetId } from './formats';

export const IPC = {
  wheelOpen: 'efc:wheel:open',
  wheelPlay: 'efc:wheel:play',
  wheelDismiss: 'efc:wheel:dismiss',
  wheelReady: 'efc:wheel:ready',
  wheelChoose: 'efc:wheel:choose',
  wheelRequestClose: 'efc:wheel:request-close',
  wheelClosed: 'efc:wheel:closed',
  wheelInteractive: 'efc:wheel:interactive',
  toastState: 'efc:toast:state',
  toastAction: 'efc:toast:action',
  toastInteractive: 'efc:toast:interactive',
  toastResize: 'efc:toast:resize',
  toastHidden: 'efc:toast:hidden',
  settingsState: 'efc:settings:state',
  settingsDismiss: 'efc:settings:dismiss',
  settingsSet: 'efc:settings:set',
  settingsRecording: 'efc:settings:recording',
  settingsClose: 'efc:settings:close',
  settingsHidden: 'efc:settings:hidden',
  settingsResize: 'efc:settings:resize',
} as const;

export type ThemeName = 'light' | 'dark';

export interface WheelTarget {
  id: TargetId;
  /** Etiqueta corta en mayúsculas, p. ej. «JPG». */
  label: string;
  /** Descripción breve para la esfera central, p. ej. «Imagen JPEG». */
  description: string;
  icon: IconId;
  /** Destinos agrupados en un pétalo propio (p. ej. «Herramientas PDF»); los demás van en la rueda principal. */
  group?: TargetGroup;
}

export type TargetGroup = 'pdf-tools' | 'image-tools';

/** Captura desenfocable del escritorio que queda detrás de la rueda (coordenadas CSS de la ventana). */
export interface WheelBackdrop {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WheelState {
  /** Identificador de apertura; evita mezclar eventos de aperturas anteriores. */
  token: number;
  /** Nombre del archivo (la interfaz lo abrevia) o «5 archivos». */
  title: string;
  /** Formato de origen, p. ej. «PNG» o «PNG · JPG». */
  sourceLabel: string;
  /** Tamaño legible, p. ej. «1,2 MB». */
  sizeLabel: string;
  /** Número de archivos seleccionados. */
  count: number;
  /** Destinos ordenados por relevancia. */
  targets: WheelTarget[];
  theme: ThemeName;
  backdrop: WheelBackdrop | null;
  /** Aviso discreto, p. ej. un motor no disponible. */
  notice: string | null;
  /** Diámetro de la rueda en píxeles CSS. */
  diameter: number;
  /** Transparencia del cristal (0 más opaca, 50 la original, 100 más transparente). */
  transparency: number;
  /** Idioma de la interfaz. */
  language: Language;
}

export type WheelCloseReason = 'escape' | 'outside' | 'toggle' | 'blur';

export type ToastStatus = 'running' | 'done' | 'error' | 'cancelled' | 'info';

export type ToastAction = 'cancel' | 'retry' | 'dismiss' | 'reveal';

export interface ToastItem {
  id: string;
  status: ToastStatus;
  /** Línea principal, p. ej. «Convirtiendo a JPG». */
  title: string;
  /** Línea secundaria: el archivo, o el motivo de un error. */
  detail: string;
  /** Cantidad procesada, p. ej. «1 de 3 procesados · 42 %» o «3 de 12 páginas»; `null` si no aplica. */
  meta?: string | null;
  /** Progreso real entre 0 y 1, o `null` si no puede calcularse (indicador indeterminado). */
  progress: number | null;
  icon: IconId;
  actions: ToastAction[];
}

export interface ToastState {
  items: ToastItem[];
  theme: ThemeName;
  /** Escritorio desenfocable detrás de la ventana de avisos (la misma captura de la rueda), si la hay. */
  backdrop: WheelBackdrop | null;
  /** Idioma de la interfaz (los textos de las tarjetas ya llegan traducidos). */
  language: Language;
}

/** Nivel de calidad de imagen; `custom` si config.json tiene valores que no son de ningún nivel. */
export type ImageQuality = 'max' | 'high' | 'balanced' | 'custom';

/** Valores que muestra y cambia la ventana de ajustes. */
export interface SettingsValues {
  /** Atajo global (acelerador de Electron, p. ej. «CommandOrControl+Shift+E»). */
  shortcut: string;
  launchAtLogin: boolean;
  contextMenu: boolean;
  language: Language;
  backdropBlur: boolean;
  wheelTransparency: number;
  excludeFromScreenCapture: boolean;
  imageQuality: ImageQuality;
  pdfDpi: number;
  shrinkMaxSide: number;
  shrinkVideoMaxSide: number;
}

export type SettingsKey = keyof SettingsValues;

/** Un cambio de un ajuste (el proceso principal lo valida antes de aplicarlo). */
export type SettingsChange = { [K in SettingsKey]: { key: K; value: SettingsValues[K] } }[SettingsKey];

export interface SettingsState {
  /** Cambia en cada apertura (para repetir la animación de entrada). */
  token: number;
  /** `false` mientras la interfaz se mide antes de mostrarse; `true` cuando ya está en pantalla. */
  visible: boolean;
  theme: ThemeName;
  /** Escritorio desenfocable detrás del panel. */
  backdrop: WheelBackdrop | null;
  values: SettingsValues;
  /** Atajo legible, p. ej. «Ctrl + Mayús + E». */
  shortcutLabel: string;
  /** El atajo está registrado (si no, otra aplicación lo usa). */
  shortcutOk: boolean;
  /** Ajustes que no se pueden cambiar en este equipo (p. ej. fuera de la versión instalada). */
  available: { launchAtLogin: boolean; contextMenu: boolean; captureExclusion: boolean };
  /** Motores disponibles, p. ej. «FFmpeg 6.1.1 · Office: Word, Excel». */
  status: string;
  version: string;
  /** Último cambio que no se pudo aplicar. */
  error: { key: SettingsKey; message: string } | null;
}

/** API expuesta en `window.efc` por el script de precarga. */
export interface EfcApi {
  readonly wheel: {
    onOpen(callback: (state: WheelState) => void): () => void;
    onPlay(callback: (token: number) => void): () => void;
    onDismiss(callback: (reason: WheelCloseReason) => void): () => void;
    ready(token: number): void;
    choose(token: number, targetId: TargetId): void;
    requestClose(token: number, reason: WheelCloseReason): void;
    closed(token: number): void;
    setInteractive(interactive: boolean): void;
  };
  readonly toast: {
    onState(callback: (state: ToastState) => void): () => void;
    action(id: string, action: ToastAction): void;
    setInteractive(interactive: boolean): void;
    resize(height: number): void;
    hidden(): void;
  };
  readonly settings: {
    onState(callback: (state: SettingsState) => void): () => void;
    /** El panel debe animar su salida y llamar después a `hidden`. */
    onDismiss(callback: () => void): () => void;
    set(change: SettingsChange): void;
    /** Mientras se graba un atajo nuevo, el actual se libera para poder pulsarlo. */
    recording(active: boolean): void;
    close(): void;
    hidden(): void;
    /** Alto que necesita el panel (px); la ventana se ajusta a él. */
    resize(height: number): void;
  };
}
