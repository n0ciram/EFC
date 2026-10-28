/**
 * Ventana de la rueda: transparente, sin marco, siempre encima y del tamaño justo.
 *
 * Ciclo: abrir → la interfaz confirma que pintó el estado inicial (invisible) → se muestra y se
 * enfoca → animación de apertura. Al cerrar, la ventana deja pasar el ratón de inmediato y se oculta
 * en cuanto termina la animación (o tras un tiempo máximo), sin dejar nada en pantalla.
 */
import { ipcMain, screen, type BrowserWindow, type IpcMainEvent } from 'electron';
import type { TargetId } from '../../src/types/formats';
import { IPC, type WheelCloseReason, type WheelState } from '../../src/types/ipc';
import { createLogger } from './logger';
import type { Rect } from './placement';
import { createSurface, isTrustedSender, loadSurface, nativeHandle } from './surfaces';

const log = createLogger('rueda');

type Phase = 'hidden' | 'opening' | 'open' | 'closing';

export interface WheelWindowOptions {
  preload: string;
  windowSize: number;
  onChoose(targetId: TargetId): void;
  onClosed(): void;
  /** Respaldo para traer la ventana al frente si Windows no le concede el foco. */
  forceFocus(hwnd: number): Promise<void>;
}

export class WheelWindow {
  private win: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private token = 0;
  private phase: Phase = 'hidden';
  private readyWaiter: { token: number; resolve(): void } | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private lastDisplayId: number | null = null;

  constructor(private readonly options: WheelWindowOptions) {
    ipcMain.on(IPC.wheelReady, (event, token: unknown) => {
      const waiter = this.readyWaiter;
      if (!this.trusted(event) || !waiter || token !== waiter.token) return;
      this.readyWaiter = null;
      waiter.resolve();
    });
    ipcMain.on(IPC.wheelChoose, (event, token: unknown, targetId: unknown) => {
      if (!this.trusted(event) || token !== this.token || this.phase !== 'open') return;
      if (typeof targetId !== 'string') return;
      this.beginClose();
      this.options.onChoose(targetId as TargetId);
    });
    ipcMain.on(IPC.wheelRequestClose, (event, token: unknown, reason: unknown) => {
      if (!this.trusted(event) || token !== this.token) return;
      this.close(['escape', 'outside', 'toggle', 'blur'].includes(String(reason)) ? (reason as WheelCloseReason) : 'outside');
    });
    ipcMain.on(IPC.wheelClosed, (event, token: unknown) => {
      if (!this.trusted(event) || token !== this.token) return;
      this.finishClose();
    });
    ipcMain.on(IPC.wheelInteractive, (event, interactive: unknown) => {
      if (!this.trusted(event) || !this.win || this.phase === 'closing' || this.phase === 'hidden') return;
      this.win.setIgnoreMouseEvents(!interactive, { forward: true });
    });
  }

  private trusted(event: IpcMainEvent): boolean {
    return isTrustedSender(this.win, event.sender, event.senderFrame?.url);
  }

  /** Crea y carga la ventana (oculta) para que abrirla sea instantáneo. */
  ensure(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.loading) return this.loading;
    const win = createSurface({ width: this.options.windowSize, height: this.options.windowSize, focusable: true, preload: this.options.preload, page: 'wheel' });
    this.win = win;
    win.on('blur', () => {
      if (this.phase === 'open' || this.phase === 'opening') this.close('blur');
    });
    win.on('closed', () => {
      this.win = null;
      this.loading = null;
      this.phase = 'hidden';
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`La interfaz de la rueda se cerró (${details.reason}); se recreará`);
      if (!win.isDestroyed()) win.destroy();
    });
    this.loading = loadSurface(win, 'wheel').catch((err: unknown) => {
      log.error('No se pudo cargar la interfaz de la rueda', err);
      throw err;
    });
    return this.loading;
  }

  isOpen(): boolean {
    return this.phase === 'opening' || this.phase === 'open';
  }

  /** Ventana subyacente (para las pruebas de extremo a extremo). */
  browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  async open(state: Omit<WheelState, 'token'>, bounds: Rect): Promise<void> {
    await this.ensure();
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const token = ++this.token;
    this.phase = 'opening';
    win.setIgnoreMouseEvents(false);

    // Con pantallas de distinto escalado, Windows puede reajustar el tamaño al cambiar de monitor:
    // se aplica dos veces para que el resultado final sea exacto.
    const display = screen.getDisplayMatching(bounds);
    win.setBounds(bounds);
    if (this.lastDisplayId !== display.id) win.setBounds(bounds);
    this.lastDisplayId = display.id;

    const ready = new Promise<void>((resolve) => {
      this.readyWaiter = { token, resolve };
      setTimeout(resolve, 300);
    });
    win.webContents.send(IPC.wheelOpen, { ...state, token } satisfies WheelState);
    await ready;
    log.debug('Rueda preparada; se muestra');
    if (token !== this.token || this.phase !== 'opening' || win.isDestroyed()) return;

    win.show();
    win.moveTop();
    win.focus();
    this.phase = 'open';
    win.webContents.send(IPC.wheelPlay, token);

    setTimeout(() => {
      if (token === this.token && this.phase === 'open' && !win.isDestroyed() && !win.isFocused()) {
        log.debug('La rueda no obtuvo el foco; se usa el respaldo del ayudante');
        this.options.forceFocus(nativeHandle(win)).catch((err: unknown) => log.warn('Respaldo de foco fallido', err));
      }
    }, 80);
  }

  /** Cierra con animación; si la interfaz no responde, se oculta igualmente. */
  close(reason: WheelCloseReason): void {
    if (!this.win || this.win.isDestroyed() || this.phase === 'hidden' || this.phase === 'closing') return;
    log.debug(`Cierre de la rueda: ${reason}`);
    this.beginClose();
    this.win.webContents.send(IPC.wheelDismiss, reason);
  }

  private beginClose(): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.phase = 'closing';
    // Desde este momento la ventana no bloquea el ratón aunque siga visible durante la animación.
    win.setIgnoreMouseEvents(true);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.finishClose(), 450);
  }

  private finishClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    const win = this.win;
    if (this.phase === 'hidden') return;
    this.phase = 'hidden';
    if (win && !win.isDestroyed()) {
      win.hide();
      win.setIgnoreMouseEvents(false);
    }
    this.options.onClosed();
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
