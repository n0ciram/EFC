/**
 * Creación segura de las ventanas transparentes de EFC (rueda, notificaciones y ajustes).
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';

export type SurfacePage = 'wheel' | 'toast' | 'settings';

export interface SurfaceOptions {
  width: number;
  height: number;
  focusable: boolean;
  preload: string;
  page: SurfacePage;
}

const DEV_SERVER = process.env.EFC_DEV_SERVER_URL;

const surfaces = new Set<BrowserWindow>();
let excludeFromCapture = false;

/**
 * Windows 10 2004 (compilación 19041) o posterior permite excluir una ventana de las capturas de
 * pantalla (`WDA_EXCLUDEFROMCAPTURE`). En versiones anteriores la ventana se capturaría en negro, así
 * que allí no se usa.
 */
export function supportsCaptureExclusion(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(process.getSystemVersion().split('.')[2]);
  return Number.isFinite(build) && build >= 19041;
}

/**
 * Excluye (o no) la rueda y los avisos de las capturas de pantalla. Así la captura del fondo nunca
 * contiene las propias ventanas de EFC y el cristal no se desenfoca a sí mismo.
 */
export function setCaptureExclusion(enabled: boolean): void {
  excludeFromCapture = enabled;
  for (const win of surfaces) if (!win.isDestroyed()) win.setContentProtection(enabled);
}

export function captureExclusionActive(): boolean {
  return excludeFromCapture;
}

export function createSurface(options: SurfaceOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    focusable: options.focusable,
    title: 'EFC',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.setMenu(null);
  surfaces.add(win);
  win.on('closed', () => surfaces.delete(win));
  if (excludeFromCapture) win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  return win;
}

export async function loadSurface(win: BrowserWindow, page: SurfacePage): Promise<void> {
  if (DEV_SERVER) {
    await win.loadURL(`${DEV_SERVER.replace(/\/$/, '')}/${page}.html`);
  } else {
    await win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', `${page}.html`));
  }
}

/** Comprueba que un mensaje IPC procede de la ventana esperada y de una página propia de EFC. */
export function isTrustedSender(win: BrowserWindow | null, sender: Electron.WebContents, frameUrl: string | undefined): boolean {
  if (!win || win.isDestroyed() || sender !== win.webContents) return false;
  if (!frameUrl) return false;
  if (DEV_SERVER) return frameUrl.startsWith(DEV_SERVER);
  return frameUrl.startsWith('file://');
}

/** Identificador nativo (HWND) de una ventana como número. */
export function nativeHandle(win: BrowserWindow): number {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0));
  return buf.readUInt32LE(0);
}
