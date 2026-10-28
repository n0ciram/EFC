/**
 * Panel de ajustes: aparece junto al icono de la bandeja, sobre el escritorio desenfocado (como la
 * rueda), y se cierra con Esc, con su botón o al hacer clic fuera. Los cambios se aplican al momento.
 *
 * Al abrirse, la interfaz se mide primero sin mostrarse; con ese alto se coloca la ventana pegada a la
 * barra de tareas, se captura el escritorio que quedará detrás y solo entonces aparece.
 */
import { ipcMain, screen, type BrowserWindow, type Display, type IpcMainEvent } from 'electron';
import { IPC, type SettingsChange, type SettingsKey, type SettingsState, type ThemeName, type WheelBackdrop } from '../../src/types/ipc';
import { cropBackdrop, type DisplayCapture } from './backdrop';
import { createLogger } from './logger';
import { placeFlyout, type Rect } from './placement';
import { createSurface, isTrustedSender, loadSurface } from './surfaces';

const log = createLogger('ajustes');

/** Ventana: panel de 360 px de ancho más 20 px de margen a cada lado para su sombra. */
export const SETTINGS_WIDTH = 400;
const DEFAULT_HEIGHT = 640;
/** Clics que llegan justo al abrir (el propio menú de la bandeja al cerrarse) no cierran el panel. */
const BLUR_GRACE_MS = 400;
/** Si la interfaz no responde a tiempo, se sigue igualmente (con el alto por defecto o sin animación). */
const MEASURE_TIMEOUT_MS = 600;
const HIDE_FALLBACK_MS = 450;

const SETTINGS_KEYS: readonly SettingsKey[] = [
  'shortcut',
  'launchAtLogin',
  'contextMenu',
  'language',
  'backdropBlur',
  'wheelTransparency',
  'excludeFromScreenCapture',
  'imageQuality',
  'pdfDpi',
  'shrinkMaxSide',
  'shrinkVideoMaxSide',
];

export interface SettingsWindowOptions {
  preload: string;
  /** Estado actual de los ajustes (lo que no depende de la ventana). */
  state(): Omit<SettingsState, 'token' | 'visible' | 'theme' | 'backdrop' | 'error'>;
  fallbackTheme(): ThemeName;
  /** Aviso en el idioma de la interfaz si un cambio falla de forma inesperada. */
  failedMessage(): string;
  /** Captura del escritorio detrás del panel, o `null` si el desenfoque está desactivado o falla. */
  capture(display: Display, region: Rect): Promise<DisplayCapture | null>;
  /** Aplica un cambio. Devuelve el motivo si no se pudo aplicar. */
  onChange(change: SettingsChange): Promise<string | null>;
  /** Grabando un atajo nuevo: el actual se libera mientras tanto. */
  onRecording(active: boolean): void;
}

export class SettingsWindow {
  private win: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private token = 0;
  private visible = false;
  private shownAt = 0;
  private recording = false;
  private anchor: Rect | null = null;
  private height = DEFAULT_HEIGHT;
  private measured: (() => void) | null = null;
  private capture: DisplayCapture | null = null;
  private glass: { backdrop: WheelBackdrop; theme: ThemeName } | null = null;
  private error: SettingsState['error'] = null;
  private hideTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SettingsWindowOptions) {
    ipcMain.on(IPC.settingsSet, (event, change: unknown) => {
      if (!this.trusted(event) || !this.visible) return;
      const c = change as { key?: unknown; value?: unknown } | null;
      if (!c || typeof c !== 'object' || !SETTINGS_KEYS.includes(c.key as SettingsKey)) return;
      const valid = { key: c.key, value: c.value } as SettingsChange;
      void this.options
        .onChange(valid)
        .catch((err: unknown) => {
          log.error(`No se pudo aplicar ${valid.key}`, err);
          return this.options.failedMessage();
        })
        .then((message) => {
          this.error = message ? { key: valid.key, message } : null;
          this.send();
        });
    });
    ipcMain.on(IPC.settingsRecording, (event, active: unknown) => {
      if (this.trusted(event)) this.setRecording(Boolean(active) && this.visible);
    });
    ipcMain.on(IPC.settingsClose, (event) => {
      if (this.trusted(event)) this.close();
    });
    ipcMain.on(IPC.settingsHidden, (event) => {
      if (this.trusted(event)) this.finishHide();
    });
    ipcMain.on(IPC.settingsResize, (event, height: unknown) => {
      if (!this.trusted(event) || typeof height !== 'number' || !Number.isFinite(height)) return;
      const next = Math.min(1200, Math.max(120, Math.ceil(height)));
      const changed = Math.abs(next - this.height) >= 1;
      this.height = next;
      if (this.measured) {
        this.measured();
        this.measured = null;
      } else if (changed && this.visible) {
        this.place();
        this.send();
      }
    });
  }

  private trusted(event: IpcMainEvent): boolean {
    return isTrustedSender(this.win, event.sender, event.senderFrame?.url);
  }

  private ensure(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.loading) return this.loading;
    const win = createSurface({
      width: SETTINGS_WIDTH,
      height: DEFAULT_HEIGHT,
      focusable: true,
      preload: this.options.preload,
      page: 'settings',
    });
    win.on('blur', () => {
      if (Date.now() - this.shownAt > BLUR_GRACE_MS) this.close();
    });
    win.on('closed', () => {
      this.win = null;
      this.loading = null;
      this.visible = false;
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`La interfaz de ajustes se cerró (${details.reason})`);
      if (!win.isDestroyed()) win.destroy();
    });
    this.win = win;
    this.loading = loadSurface(win, 'settings').catch((err: unknown) => {
      log.error('No se pudo cargar la interfaz de ajustes', err);
      throw err;
    });
    return this.loading;
  }

  /** Coloca la ventana junto al ancla con el alto actual y recorta el escritorio que queda detrás. */
  private place(): Rect | null {
    const win = this.win;
    const anchor = this.anchor;
    if (!win || win.isDestroyed() || !anchor) return null;
    const display = this.displayFor(anchor);
    const rect = placeFlyout(anchor, SETTINGS_WIDTH, Math.min(this.height, display.workArea.height), display.workArea);
    win.setBounds(rect);
    if (this.capture) {
      const cropped = cropBackdrop(this.capture, rect, {
        x: rect.x,
        y: rect.y,
      });
      this.glass = cropped ? { backdrop: cropped.backdrop, theme: cropped.theme } : null;
    }
    return rect;
  }

  private displayFor(anchor: Rect): Display {
    return screen.getDisplayNearestPoint({
      x: Math.round(anchor.x + anchor.width / 2),
      y: Math.round(anchor.y + anchor.height / 2),
    });
  }

  /** Muestra el panel junto a `anchor` (el icono de la bandeja). */
  async open(anchor: Rect): Promise<void> {
    await this.ensure();
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.hideTimer) this.finishHide();
    this.anchor = anchor;
    this.capture = null;
    this.glass = null;
    this.error = null;
    this.token++;

    // 1. La interfaz se mide (oculta) con los valores actuales.
    const measured = new Promise<void>((resolve) => {
      this.measured = resolve;
      setTimeout(resolve, MEASURE_TIMEOUT_MS);
    });
    this.send();
    await measured;
    this.measured = null;

    // 2. Se coloca, se captura lo que quedará detrás y se muestra.
    const rect = this.place();
    if (!rect) return;
    this.capture = await this.options.capture(this.displayFor(anchor), rect).catch(() => null);
    this.place();
    this.shownAt = Date.now();
    this.visible = true;
    this.send();
    win.show();
    win.focus();
    log.info(`Ajustes abiertos${this.glass ? '' : ' (sin desenfoque)'}`);
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Vuelve a enviar el estado (tras un cambio aplicado desde fuera). */
  refresh(): void {
    if (this.visible) this.send();
  }

  /** Cierra con la animación de salida. */
  close(): void {
    const win = this.win;
    if (!this.visible || !win || win.isDestroyed() || this.hideTimer) return;
    win.webContents.send(IPC.settingsDismiss);
    this.hideTimer = setTimeout(() => this.finishHide(), HIDE_FALLBACK_MS);
  }

  private finishHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this.visible = false;
    this.capture = null;
    this.glass = null;
    this.setRecording(false);
  }

  private setRecording(active: boolean): void {
    if (active === this.recording) return;
    this.recording = active;
    this.options.onRecording(active);
  }

  private send(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const state: SettingsState = {
      ...this.options.state(),
      token: this.token,
      visible: this.visible,
      theme: this.glass?.theme ?? this.options.fallbackTheme(),
      backdrop: this.glass?.backdrop ?? null,
      error: this.error,
    };
    win.webContents.send(IPC.settingsState, state);
  }

  /** Ventana subyacente (para las pruebas de extremo a extremo). */
  browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  destroy(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
