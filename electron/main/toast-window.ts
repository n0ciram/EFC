/**
 * Ventana de notificaciones: tarjetas de cristal pequeñas junto al lugar donde estaba la rueda.
 *
 * No roba el foco (no es enfocable y se muestra sin activarse) y deja pasar el ratón salvo sobre
 * las tarjetas. Las tarjetas terminadas desaparecen solas; las de error permanecen hasta cerrarlas.
 */
import { ipcMain, screen, type BrowserWindow, type IpcMainEvent } from 'electron';
import type { Language } from '../../src/i18n';
import { IPC, type ThemeName, type ToastAction, type ToastItem, type ToastState, type WheelBackdrop } from '../../src/types/ipc';
import { cropBackdrop, type DisplayCapture } from './backdrop';
import { createLogger } from './logger';
import { placeToast, type Point } from './placement';
import { createSurface, isTrustedSender, loadSurface } from './surfaces';

const log = createLogger('aviso');

/** Ancho de la ventana (tarjeta de 340 + márgenes para la sombra). */
export const TOAST_WINDOW_WIDTH = 388;
const DEFAULT_HEIGHT = 120;
/** Distancia desde el borde superior de la ventana hasta el centro de la primera tarjeta (ver toast.css). */
const FIRST_CARD_CENTER = 60;
/** Tarjetas visibles como máximo: si hay más, se retiran primero las terminadas más antiguas. */
const MAX_CARDS = 4;
const AUTO_DISMISS_MS: Partial<Record<ToastItem['status'], number>> = {
  done: 3200,
  cancelled: 1800,
  info: 4500,
};

interface Entry {
  item: ToastItem;
  anchor: Point;
  timer: NodeJS.Timeout | null;
  /** Momento en que la tarjeta pasó a un estado final (para el cierre automático). */
  settledAt: number | null;
}

export interface ToastWindowOptions {
  preload: string;
  theme(): ThemeName;
  language(): Language;
  onAction(id: string, action: ToastAction): void;
  onExpire(id: string): void;
}

export class ToastWindow {
  private win: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private readonly entries = new Map<string, Entry>();
  private anchor: Point | null = null;
  private contentHeight = DEFAULT_HEIGHT;
  private hovered = false;
  private visible = false;
  /** Última captura del escritorio (la de la rueda) para desenfocar también detrás de los avisos. */
  private capture: { data: DisplayCapture; at: number } | null = null;
  private backdropCache: { key: string; backdrop: WheelBackdrop; theme: ThemeName } | null = null;

  constructor(private readonly options: ToastWindowOptions) {
    ipcMain.on(IPC.toastAction, (event, id: unknown, action: unknown) => {
      if (!this.trusted(event) || typeof id !== 'string' || !this.entries.has(id)) return;
      const entry = this.entries.get(id) as Entry;
      if (typeof action !== 'string' || !entry.item.actions.includes(action as ToastAction)) return;
      this.options.onAction(id, action as ToastAction);
    });
    ipcMain.on(IPC.toastInteractive, (event, interactive: unknown) => {
      if (!this.trusted(event) || !this.win) return;
      this.hovered = Boolean(interactive);
      this.win.setIgnoreMouseEvents(!this.hovered, { forward: true });
      // Mientras el cursor está sobre una tarjeta, no se cierra sola.
      if (this.hovered) for (const entry of this.entries.values()) this.clearTimer(entry);
      else for (const entry of this.entries.values()) this.armTimer(entry);
    });
    ipcMain.on(IPC.toastResize, (event, height: unknown) => {
      if (!this.trusted(event) || typeof height !== 'number') return;
      const next = Math.min(900, Math.max(40, height));
      if (Math.abs(next - this.contentHeight) < 1) return;
      this.contentHeight = next;
      this.reposition();
      this.send();
    });
    ipcMain.on(IPC.toastHidden, (event) => {
      if (!this.trusted(event)) return;
      if (this.entries.size === 0 && this.win && !this.win.isDestroyed()) {
        this.win.hide();
        this.visible = false;
        this.hovered = false;
      }
    });
  }

  private trusted(event: IpcMainEvent): boolean {
    return isTrustedSender(this.win, event.sender, event.senderFrame?.url);
  }

  private ensure(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.loading) return this.loading;
    const win = createSurface({ width: TOAST_WINDOW_WIDTH, height: DEFAULT_HEIGHT, focusable: false, preload: this.options.preload, page: 'toast' });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.on('closed', () => {
      this.win = null;
      this.loading = null;
      this.visible = false;
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`La interfaz de avisos se cerró (${details.reason})`);
      if (!win.isDestroyed()) win.destroy();
    });
    this.win = win;
    this.loading = loadSurface(win, 'toast').catch((err: unknown) => {
      log.error('No se pudo cargar la interfaz de avisos', err);
      throw err;
    });
    return this.loading;
  }

  /** Precarga la ventana (oculta) para que el primer aviso aparezca sin espera. */
  prepare(): Promise<void> {
    return this.ensure().catch(() => undefined);
  }

  /** Crea o actualiza una tarjeta. */
  upsert(item: ToastItem, anchor: Point): void {
    const existing = this.entries.get(item.id);
    if (!existing && this.anchor && (Math.abs(anchor.x - this.anchor.x) > 1 || Math.abs(anchor.y - this.anchor.y) > 1) && this.visible) {
      // Un aviso nuevo en otro lugar: la pila se traslada allí.
      this.anchor = anchor;
      this.reposition();
    }
    const isFinal = item.status !== 'running';
    if (existing) {
      const becameFinal = isFinal && existing.item.status === 'running';
      existing.item = item;
      if (becameFinal) existing.settledAt = Date.now();
      this.armTimer(existing);
    } else {
      const entry: Entry = { item, anchor, timer: null, settledAt: isFinal ? Date.now() : null };
      this.entries.set(item.id, entry);
      this.anchor = anchor;
      this.armTimer(entry);
      this.trim();
    }
    void this.sync();
  }

  /** Mantiene la pila corta: retira las tarjetas terminadas más antiguas (los errores, en último lugar). */
  private trim(): void {
    if (this.entries.size <= MAX_CARDS) return;
    const removable = [...this.entries.values()].filter((e) => e.item.status !== 'running');
    const rank = (e: Entry): number => (e.item.status === 'error' ? 1 : 0);
    removable.sort((a, b) => rank(a) - rank(b));
    while (this.entries.size > MAX_CARDS && removable.length > 0) {
      const entry = removable.shift() as Entry;
      this.clearTimer(entry);
      this.entries.delete(entry.item.id);
      this.options.onExpire(entry.item.id);
    }
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.clearTimer(entry);
    this.entries.delete(id);
    void this.sync();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Ventana subyacente (para las pruebas de extremo a extremo). */
  browserWindow(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private armTimer(entry: Entry): void {
    this.clearTimer(entry);
    const ttl = AUTO_DISMISS_MS[entry.item.status];
    if (!ttl || this.hovered) return;
    entry.timer = setTimeout(() => {
      this.entries.delete(entry.item.id);
      this.options.onExpire(entry.item.id);
      void this.sync();
    }, ttl);
  }

  /** Hay tarjetas en pantalla. */
  isShowing(): boolean {
    return this.visible && this.entries.size > 0;
  }

  /** La captura de la rueda sirve para los avisos que aparecen en el mismo sitio poco después. */
  setCapture(capture: DisplayCapture | null): void {
    this.capture = capture ? { data: capture, at: Date.now() } : null;
    this.backdropCache = null;
  }

  private backdropFor(): { backdrop: WheelBackdrop; theme: ThemeName } | null {
    const win = this.win;
    const capture = this.capture;
    if (!win || win.isDestroyed() || !capture) return null;
    if (Date.now() - capture.at > 120_000) {
      this.capture = null;
      return null;
    }
    const bounds = win.getBounds();
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (this.backdropCache?.key === key) return this.backdropCache;
    const cropped = cropBackdrop(capture.data, bounds, { x: bounds.x, y: bounds.y });
    if (!cropped) return null;
    this.backdropCache = { key, backdrop: cropped.backdrop, theme: cropped.theme };
    return this.backdropCache;
  }

  private state(): ToastState {
    const glass = this.backdropFor();
    return {
      items: [...this.entries.values()].map((e) => e.item),
      theme: glass?.theme ?? this.options.theme(),
      backdrop: glass?.backdrop ?? null,
      language: this.options.language(),
    };
  }

  private send(): void {
    const win = this.win;
    if (win && !win.isDestroyed()) win.webContents.send(IPC.toastState, this.state());
  }

  private async sync(): Promise<void> {
    if (this.entries.size === 0 && !this.win) return;
    try {
      await this.ensure();
    } catch {
      return;
    }
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (this.entries.size > 0 && !this.visible) {
      this.reposition();
      this.send();
      win.showInactive();
      win.setAlwaysOnTop(true, 'pop-up-menu');
      this.visible = true;
      return;
    }
    this.send();
    // Cuando no quedan tarjetas, la interfaz anima la salida y avisa con «hidden».
  }

  private reposition(): void {
    const win = this.win;
    const anchor = this.anchor;
    if (!win || win.isDestroyed() || !anchor) return;
    const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
    const height = Math.ceil(this.contentHeight);
    // El ancla es el centro de la primera tarjeta; la pila crece hacia abajo.
    const rect = placeToast({ x: anchor.x, y: anchor.y - FIRST_CARD_CENTER + height / 2 }, TOAST_WINDOW_WIDTH, height, display.workArea);
    win.setBounds(rect);
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.clearTimer(entry);
    this.entries.clear();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
