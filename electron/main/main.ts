/**
 * EFC — Easy File Converter. Proceso principal de Electron.
 *
 * Orquesta los módulos: atajo global → ayudante del Explorador (ventana activa y selección) →
 * validación y detección de formatos → rueda radial → cola de conversión en un proceso aislado →
 * notificación de progreso. La aplicación no muestra ninguna ventana hasta que se usa.
 */
import { app, globalShortcut, nativeImage, nativeTheme, screen, session, shell, type BrowserWindow, type Display, type NativeImage } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { TargetId } from '../../src/types/formats';
import { languageFromInstallerId, languageFromLocale, messages, type Messages } from '../../src/i18n';
import type { SettingsChange, SettingsState, ThemeName, ToastAction, WheelBackdrop, WheelState } from '../../src/types/ipc';
import { FORMATS } from '../conversion/formats';
import type { OfficeRunner } from '../conversion/adapters/office';
import { availableTargets, explainNoTargets, OFFICE_APP_NAMES, type EngineCaps, type OfficeApp, type TargetOption } from '../conversion/registry';
import { ExplorerHelper, type ExplorerSelection, type HelperItem, type HelperRect, type QueryResult } from '../windows/explorer-helper';
import { formatBytes, MAX_SELECTION, resolveSelection, type SelectedFile } from '../windows/selection';
import { GlobalShortcut, parseAccelerator } from '../windows/shortcut';
import { extensionsFromMarker, importRegistry, menuExtensions, registrationMarker, registryScript } from '../windows/context-menu';
import { detectOffice } from '../windows/office';
import { OpenRequestServer } from './open-requests';
import { captureDisplay, captureRegion, cropBackdrop, type DisplayCapture } from './backdrop';
import { ConfigStore, type AppConfig } from './config';
import { locateFfmpeg } from './ffmpeg-locator';
import { JobManager } from './jobs';
import { createLogger, getLogFile, initLogger } from './logger';
import { chooseAnchor, placeWheel, type Point, type Rect } from './placement';
import { patchFor, settingsValues } from './settings-model';
import { SettingsWindow } from './settings-window';
import { jobToToast } from './toast-presenter';
import { captureExclusionActive, setCaptureExclusion, supportsCaptureExclusion } from './surfaces';
import { TOAST_WINDOW_WIDTH, ToastWindow } from './toast-window';
import { AppTray } from './tray';
import { WheelWindow } from './wheel-window';
import { WorkerClient } from './worker-client';

const log = createLogger('principal');

/** Diámetro visible de la rueda y margen transparente para sombra, rebote y ampliación. */
const WHEEL_DIAMETER = 300;
const WHEEL_PADDING = 48;
const WHEEL_WINDOW = WHEEL_DIAMETER + WHEEL_PADDING * 2;
/** Margen extra de la captura del fondo para que el desenfoque no oscurezca los bordes. */
const BACKDROP_MARGIN = 40;

// Captura de pantalla de respaldo sin Windows.Graphics.Capture (evita el marco amarillo de Windows 11).
app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer,AllowWgcScreenCapturer,WebRtcAllowWgcDesktopCapturer');

interface OpenContext {
  files: SelectedFile[];
  targets: TargetOption[];
  center: Point;
}

let config: ConfigStore;
let caps: EngineCaps = { image: true, pdf: true, ffmpeg: null, office: null };
/** Termina cuando se sabe si hay Office (el menú contextual depende de ello). */
let officeDetection: Promise<void> = Promise.resolve();
let helper: ExplorerHelper | null = null;
let shortcut: GlobalShortcut | null = null;
let shortcutOk = false;
let wheel: WheelWindow;
let toast: ToastWindow;
let jobs: JobManager;
let worker: WorkerClient;
let tray: AppTray | null = null;
let openContext: OpenContext | null = null;
let busy = false;
let lastOpenAt = 0;
let lastTheme: ThemeName = 'light';
let infoCounter = 0;
let quitting = false;
let openRequests: OpenRequestServer | null = null;
let settingsWindow: SettingsWindow | null = null;
/** Solo en las pruebas E2E: imagen fija del escritorio en lugar de una captura real. */
let staticBackdrop: NativeImage | null = null;

function helperPaths(): { exe: string; script: string; source: string; powershell: string } {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'helper');
    return { exe: path.join(dir, 'efc-helper.exe'), script: path.join(dir, 'efc-helper.ps1'), source: path.join(dir, 'EfcHelper.cs'), powershell };
  }
  const root = app.getAppPath();
  const sources = path.join(root, 'electron', 'windows', 'helper');
  return {
    exe: path.join(root, 'resources', 'bin', 'efc-helper.exe'),
    script: path.join(sources, 'efc-helper.ps1'),
    source: path.join(sources, 'EfcHelper.cs'),
    powershell,
  };
}

/** Script que exporta a PDF con Office (Word, Excel, PowerPoint). */
function officeRunner(): OfficeRunner {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'office', 'efc-office.ps1')
    : path.join(app.getAppPath(), 'electron', 'conversion', 'adapters', 'efc-office.ps1');
  return { powershell: helperPaths().powershell, script };
}

/** Fuente monoespaciada incluida para escribir texto en PDF. */
function textFontPath(): string {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'fonts') : path.join(app.getAppPath(), 'resources', 'fonts');
  return path.join(dir, 'DejaVuSansMono.ttf');
}

function iconsDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(app.getAppPath(), 'resources', 'icons');
}

/** Textos en el idioma elegido. */
function text(): Messages {
  return messages(config.value.language);
}

function shortcutLabel(): string {
  return parseAccelerator(config.value.shortcut, text().keys)?.label ?? config.value.shortcut;
}

/**
 * El instalador deja el idioma elegido en `installer-language.txt` junto a EFC.exe. Se aplica una vez
 * por instalación (la fecha del archivo la distingue); después manda lo que se elija en Ajustes.
 */
function applyInstallerLanguage(): void {
  if (!app.isPackaged) return;
  const file = path.join(path.dirname(process.execPath), 'installer-language.txt');
  try {
    const id = readFileSync(file, 'utf8');
    const marker = `${id.trim()}|${Math.round(statSync(file).mtimeMs)}`;
    if (config.value.installerLanguageApplied === marker) return;
    const language = languageFromInstallerId(id);
    config.update({ installerLanguageApplied: marker, ...(language ? { language } : {}) });
    log.info(`Idioma elegido en el instalador: ${language ?? `desconocido (${id.trim()})`}`);
  } catch {
    // Sin archivo (versión anterior del instalador): se mantiene el idioma guardado.
  }
}

/** Coordenadas físicas del ayudante → DIP de Electron (Windows con escalado). */
function toDipRect(r: HelperRect): Rect {
  const physical = { x: r.l, y: r.t, width: r.r - r.l, height: r.b - r.t };
  if (process.platform !== 'win32') return physical;
  return screen.screenToDipRect(null, physical);
}

/** DIP → píxeles físicos (para capturar exactamente lo que hay detrás de la rueda). */
function toPhysicalRect(r: Rect): Rect {
  if (process.platform !== 'win32') return r;
  return screen.dipToScreenRect(null, r);
}

/** El menú contextual solo se registra en la versión instalada de Windows (necesita rutas estables). */
function contextMenuAvailable(): boolean {
  return app.isPackaged && process.platform === 'win32';
}

/** Registra o retira «Convertir con EFC» según la configuración (solo si ha cambiado algo). */
async function applyContextMenu(): Promise<void> {
  if (!contextMenuAvailable()) return;
  await officeDetection;
  const enabled = config.value.contextMenu;
  const helperExe = helperPaths().exe;
  const extensions = menuExtensions(caps.office ?? null);
  const marker = enabled ? registrationMarker(app.getVersion(), helperExe, extensions, config.value.language) : '';
  if (config.value.contextMenuApplied === marker) return;
  try {
    const previous = extensionsFromMarker(config.value.contextMenuApplied);
    await importRegistry(registryScript({ register: enabled, helperExe, iconExe: process.execPath, extensions, text: text().contextMenu, previous }));
    config.update({ contextMenuApplied: marker });
    log.info(enabled ? 'Menú contextual «Convertir con EFC» registrado' : 'Menú contextual retirado');
  } catch (err) {
    log.warn('No se pudo actualizar el menú contextual del Explorador', err);
  }
}

/** Abre la rueda para archivos concretos (menú contextual del Explorador y pruebas). */
async function openFiles(paths: string[], at?: Point): Promise<boolean> {
  const cursor = at ?? screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const items: HelperItem[] = paths.map((p) => ({ path: p, name: path.basename(p), isFolder: false, isFileSystem: true, isLink: false }));
  const area = display.bounds;
  const query: ExplorerSelection = {
    ok: true,
    kind: 'explorer',
    hwnd: 0,
    pid: 0,
    tabs: 1,
    tabMatched: false,
    folder: paths[0] ? path.dirname(paths[0]) : null,
    items,
    truncated: false,
    cursor,
    window: { l: area.x, t: area.y, r: area.x + area.width, b: area.y + area.height },
    item: null,
    ms: 0,
  };
  const provisional = placeWheel(cursor, WHEEL_DIAMETER, WHEEL_WINDOW, display.workArea);
  const capture = config.value.backdropBlur ? grabBackdrop(display, provisional.center) : Promise.resolve(null);
  return presentSelection(query, { cursor, started: Date.now(), capture, captureCenter: provisional.center });
}

/** «Convertir con EFC» en el menú del botón derecho: llegan las rutas ya reunidas. */
async function onMenuRequest(paths: string[]): Promise<void> {
  if (busy) {
    setTimeout(() => void onMenuRequest(paths), 200);
    return;
  }
  if (wheel.isOpen()) wheel.close('toggle');
  busy = true;
  try {
    log.info(`Menú contextual: ${paths.length} archivo(s)`);
    const shown = await openFiles(paths);
    if (!shown) notify(text().notify.nothingTitle, text().notify.nothingDetail);
  } catch (err) {
    log.error('Error al abrir la rueda desde el menú contextual', err);
  } finally {
    busy = false;
  }
}

function notify(title: string, detail: string, anchor?: Point, icon: 'info' | 'alert' = 'info'): void {
  const point = anchor ?? defaultAnchor();
  const id = `info-${++infoCounter}`;
  toast.upsert({ id, status: 'info', title, detail, progress: null, icon, actions: ['dismiss'] }, point);
}

function defaultAnchor(): Point {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width / 2, y: area.y + area.height - 90 };
}

/** Zona que se captura alrededor del centro de la rueda: la rueda con margen y la pila de avisos. */
function backdropRegion(center: Point): Rect {
  const halfWidth = Math.max(WHEEL_WINDOW / 2 + BACKDROP_MARGIN, TOAST_WINDOW_WIDTH / 2 + 12);
  const halfHeight = WHEEL_WINDOW / 2 + BACKDROP_MARGIN;
  return {
    x: Math.round(center.x - halfWidth),
    y: Math.round(center.y - halfHeight),
    width: Math.round(halfWidth * 2),
    height: Math.round(halfHeight * 2 + 90),
  };
}

/** Captura el escritorio detrás de la rueda: con el ayudante (rápido y solo la zona) o, si no, con Chromium. */
async function grabBackdrop(display: Display, center: Point): Promise<DisplayCapture | null> {
  if (staticBackdrop) return { displayId: display.id, bounds: { ...display.bounds }, image: staticBackdrop };
  const h = helper;
  if (h?.canCapture) {
    const shot = await captureRegion(display, backdropRegion(center), (rect, percent) => h.capture(rect, percent), toPhysicalRect);
    if (shot) return shot;
  }
  return captureDisplay(display);
}

async function passThrough(): Promise<void> {
  if (!config.value.passThroughShortcut || !helper || !shortcut) return;
  const parsed = parseAccelerator(config.value.shortcut);
  if (!parsed) return;
  const h = helper;
  await shortcut.passThrough(async () => {
    await h.request('passthrough', [parsed.vk, parsed.mods], 1500);
  });
}

function explainHelperError(code: string): string {
  const t = text().notify;
  switch (code) {
    case 'ambiguous_tab':
      return t.ambiguousTab;
    case 'window_not_found':
      return t.windowNotFound;
    case 'selection_unavailable':
      return t.selectionUnavailable;
    default:
      return t.selectionFailed;
  }
}

function buildWheelState(files: SelectedFile[], targets: TargetOption[], theme: ThemeName, backdrop: WheelBackdrop | null, notice: string | null): Omit<WheelState, 'token'> {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const formats = [...new Set(files.map((f) => FORMATS[f.format].label))];
  return {
    title: files.length === 1 ? (files[0] as SelectedFile).name : text().files(files.length),
    sourceLabel: formats.length <= 2 ? formats.join(' · ') : text().wheel.mixed,
    sizeLabel: formatBytes(totalSize, config.value.language),
    count: files.length,
    targets: targets.map((t) => ({ id: t.id, label: t.label, description: t.description, icon: t.icon, ...(t.group ? { group: t.group } : {}) })),
    theme,
    backdrop,
    notice,
    diameter: WHEEL_DIAMETER,
    transparency: config.value.wheelTransparency,
    language: config.value.language,
  };
}

interface PresentOptions {
  cursor: Point;
  started: number;
  /** Captura iniciada en paralelo con la consulta, centrada en esta posición provisional. */
  capture: Promise<DisplayCapture | null>;
  captureCenter: Point;
}

/** Valida la selección y abre la rueda junto al archivo. Devuelve `false` si no hay nada que mostrar. */
async function presentSelection(query: ExplorerSelection, options: PresentOptions): Promise<boolean> {
  const { cursor } = options;
  const selection = await resolveSelection(query.items);
  log.debug(`Selección: ${selection.files.length} archivo(s), ${selection.rejected.length} rechazado(s)`);
  if (selection.files.length === 0) {
    const first = selection.rejected[0];
    if (first) {
      notify(text().notify.cannotTitle, `${first.name}: ${text().rejected[first.reason]}.`, cursor);
      return true;
    }
    return false; // nada seleccionado o solo carpetas: el atajo sigue siendo del Explorador
  }
  const targets = availableTargets(selection.files, caps, config.value.language);
  if (targets.length === 0) {
    notify(text().notify.noTargetsTitle, explainNoTargets(selection.files, caps, config.value.language), cursor);
    return true;
  }

  let notice: string | null = null;
  const w = text().wheel;
  if (selection.tooMany || query.truncated) notice = w.tooMany(MAX_SELECTION);
  else if (selection.rejected.length > 0) notice = w.rejected(selection.rejected.length);
  else if (selection.files.length === 1 && selection.files[0]?.extensionMismatch) notice = w.mismatch(FORMATS[selection.files[0].format].label);

  const explorerRect = toDipRect(query.window);
  const itemRect = query.item ? toDipRect(query.item) : null;
  const anchor = chooseAnchor(cursor, explorerRect, itemRect);
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.point.x), y: Math.round(anchor.point.y) });
  const placement = placeWheel(anchor.point, WHEEL_DIAMETER, WHEEL_WINDOW, display.workArea);

  let theme: ThemeName = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  let backdrop: WheelBackdrop | null = null;
  let capture: DisplayCapture | null = null;
  if (config.value.backdropBlur) {
    const moved = Math.abs(placement.center.x - options.captureCenter.x) > 1 || Math.abs(placement.center.y - options.captureCenter.y) > 1;
    capture = await options.capture;
    log.debug(`Fondo ${capture ? 'listo' : 'no disponible'}`);
    // La rueda acabó en otro sitio (cursor fuera del Explorador): se captura la zona correcta.
    if (moved || (capture && capture.displayId !== display.id)) capture = await grabBackdrop(display, placement.center);
  }
  // Sin exclusión de capturas (Windows anterior a 2004), una captura tomada con avisos en pantalla los
  // incluiría: los avisos conservan entonces la captura anterior.
  if (captureExclusionActive() || staticBackdrop || !toast.isShowing()) toast.setCapture(capture && capture.displayId === display.id ? capture : null);
  if (capture && capture.displayId === display.id) {
    const region = {
      x: placement.window.x - BACKDROP_MARGIN,
      y: placement.window.y - BACKDROP_MARGIN,
      width: WHEEL_WINDOW + BACKDROP_MARGIN * 2,
      height: WHEEL_WINDOW + BACKDROP_MARGIN * 2,
    };
    const cropped = cropBackdrop(capture, region, { x: placement.window.x, y: placement.window.y });
    if (cropped) {
      backdrop = cropped.backdrop;
      theme = cropped.theme;
    }
  }
  lastTheme = theme;

  openContext = { files: selection.files, targets, center: placement.center };
  await wheel.open(buildWheelState(selection.files, targets, theme, backdrop, notice), placement.window);
  lastOpenAt = Date.now();
  log.info(
    `Rueda: ${selection.files.length} archivo(s), ${targets.length} destino(s), ancla ${anchor.source}, ` +
      `${Date.now() - options.started} ms (consulta ${query.ms} ms, pestañas ${query.tabs}, fondo ${backdrop ? 'sí' : 'no'})`,
  );
  return true;
}

async function onHotkey(): Promise<void> {
  if (busy) return;
  if (wheel.isOpen()) {
    // Volver a pulsar el atajo cierra la rueda (ignorando la repetición automática del teclado).
    if (Date.now() - lastOpenAt > 400) wheel.close('toggle');
    return;
  }
  if (!helper) {
    log.warn('La integración con el Explorador solo está disponible en Windows.');
    return;
  }
  busy = true;
  const started = Date.now();
  const cursor = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursor);
  const provisional = placeWheel(cursor, WHEEL_DIAMETER, WHEEL_WINDOW, cursorDisplay.workArea);
  try {
    // La detección se hace ahora, al pulsar el atajo. La captura del fondo va en cola justo detrás
    // (el ayudante las atiende en orden) para no añadir espera.
    const queryPromise = helper.request<QueryResult>('query', [], 3000);
    const capture = config.value.backdropBlur ? grabBackdrop(cursorDisplay, provisional.center) : Promise.resolve(null);
    capture.catch(() => undefined);

    let query: QueryResult;
    try {
      query = await queryPromise;
    } catch (err) {
      log.error('La consulta al Explorador falló', err);
      notify(text().notify.detectionTitle, text().notify.detectionNoContact, cursor, 'alert');
      return;
    }
    if (!query.ok) {
      log.warn(`Selección no fiable: ${query.error} ${query.detail ?? ''}`);
      notify(text().notify.selectionTitle, explainHelperError(query.error), cursor, 'alert');
      return;
    }
    if (query.kind !== 'explorer') {
      log.debug(`Atajo fuera del Explorador (${query.kind}${query.class ? `: ${query.class}` : ''})`);
      await passThrough();
      return;
    }
    const shown = await presentSelection(query, { cursor, started, capture, captureCenter: provisional.center });
    if (!shown) await passThrough();
  } catch (err) {
    log.error('Error al abrir la rueda', err);
  } finally {
    busy = false;
  }
}

function onChoose(targetId: TargetId): void {
  const context = openContext;
  openContext = null;
  if (!context) return;
  const target = context.targets.find((t) => t.id === targetId);
  if (!target) {
    log.warn(`Destino no ofrecido: ${targetId}`);
    return;
  }
  const { job, duplicate } = jobs.enqueue(context.files, target, context.center);
  if (duplicate) {
    log.info(`Conversión ya en curso (${job.id}); no se duplica`);
    toast.upsert(jobToToast(job, config.value.language), job.anchor);
  }
}

function onToastAction(id: string, action: ToastAction): void {
  switch (action) {
    case 'cancel':
      jobs.cancel(id);
      break;
    case 'retry': {
      toast.remove(id);
      const next = jobs.retry(id);
      if (!next) log.warn(`No se pudo reintentar ${id}`);
      break;
    }
    case 'reveal': {
      const output = jobs.get(id)?.result?.outputs[0]?.output;
      if (output) shell.showItemInFolder(output);
      toast.remove(id);
      jobs.forget(id);
      break;
    }
    case 'dismiss':
      toast.remove(id);
      jobs.forget(id);
      break;
  }
}

function applyLoginItem(): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({ openAtLogin: config.value.launchAtLogin, path: process.execPath, args: ['--autostart'] });
  } catch (err) {
    log.warn('No se pudo configurar el inicio con Windows', err);
  }
}

function refreshTray(): void {
  if (!config.value.trayIcon) {
    tray?.hide();
    return;
  }
  tray ??= new AppTray(iconsDir(), {
    openSettings: () => void openSettings(),
    openLog: () => {
      const file = getLogFile();
      if (file) void shell.openPath(file);
    },
    quit: () => app.quit(),
  });
  tray.show({ shortcutLabel: shortcutLabel(), shortcutOk, text: text().tray });
  settingsWindow?.refresh();
}

// --- Ajustes ------------------------------------------------------------------------------------------

/** Abre el panel de ajustes junto al icono de la bandeja (o junto al cursor si no se sabe dónde está). */
async function openSettings(): Promise<void> {
  if (!settingsWindow) return;
  if (settingsWindow.isVisible()) {
    settingsWindow.close();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const anchor = tray?.bounds() ?? { x: cursor.x, y: cursor.y, width: 1, height: 1 };
  // Deja que el menú de la bandeja termine de cerrarse para que no salga en la captura del fondo.
  await new Promise((r) => setTimeout(r, 150));
  await settingsWindow.open(anchor);
}

/** Motores disponibles, para la línea de estado del panel. */
function enginesStatus(): string {
  const t = text().settings;
  const parts = [caps.ffmpeg ? `FFmpeg ${caps.ffmpeg.version.split('-')[0]}` : t.noFfmpeg];
  const office = caps.office ? (Object.keys(caps.office) as OfficeApp[]).filter((a) => caps.office?.[a]).map((a) => OFFICE_APP_NAMES[a]) : [];
  parts.push(office.length > 0 ? t.office(office.join(', ')) : t.noOffice);
  return parts.join(' · ');
}

function settingsState(): Omit<SettingsState, 'token' | 'visible' | 'theme' | 'backdrop' | 'error'> {
  return {
    values: settingsValues(config.value),
    shortcutLabel: shortcutLabel(),
    shortcutOk,
    available: {
      launchAtLogin: app.isPackaged && process.platform === 'win32',
      contextMenu: contextMenuAvailable(),
      captureExclusion: supportsCaptureExclusion(),
    },
    status: enginesStatus(),
    version: app.getVersion(),
  };
}

/** Aplica un cambio de la ventana de ajustes. Devuelve el motivo si no se pudo. */
async function applySettingsChange(change: SettingsChange): Promise<string | null> {
  const result = patchFor(config.value, change, text());
  if (!result.ok) return result.message;
  if (change.key === 'shortcut') return changeShortcut(change.value);
  config.update(result.patch);
  log.info(`Ajuste cambiado: ${change.key} = ${JSON.stringify(change.value)}`);
  switch (change.key) {
    case 'launchAtLogin':
      applyLoginItem();
      break;
    case 'contextMenu':
      await applyContextMenu();
      break;
    case 'excludeFromScreenCapture':
      applyCaptureExclusion();
      break;
    case 'language':
      // «Convertir con EFC» del botón derecho también cambia de idioma.
      await applyContextMenu();
      break;
    default:
      break;
  }
  refreshTray();
  return null;
}

/** Cambia el atajo global; si la combinación está ocupada, se conserva la anterior. */
function changeShortcut(accelerator: string): string | null {
  const previous = config.value.shortcut;
  if (accelerator === previous && shortcutOk) return null;
  shortcut?.unregister();
  const candidate = new GlobalShortcut(accelerator, () => void onHotkey(), globalShortcut);
  if (!candidate.register()) {
    registerShortcut();
    return text().settings.errors.busy;
  }
  shortcut = candidate;
  shortcutOk = true;
  config.update({ shortcut: accelerator });
  log.info(`Atajo cambiado: ${previous} → ${accelerator}`);
  refreshTray();
  return null;
}

/** Mientras se graba un atajo nuevo, el actual se libera para que la combinación llegue al panel. */
function onShortcutRecording(active: boolean): void {
  if (active) shortcut?.unregister();
  else registerShortcut();
}

function applyCaptureExclusion(): void {
  const enabled = config.value.excludeFromScreenCapture && supportsCaptureExclusion();
  setCaptureExclusion(enabled);
  if (process.platform === 'win32') log.info(`Rueda y avisos ${enabled ? 'excluidos' : 'no excluidos'} de las capturas de pantalla`);
}

function registerShortcut(): void {
  shortcut?.unregister();
  shortcut = new GlobalShortcut(config.value.shortcut, () => void onHotkey(), globalShortcut);
  shortcutOk = shortcut.register();
  if (!shortcutOk) {
    notify(text().notify.shortcutTitle, text().notify.shortcutBusy(shortcutLabel()), undefined, 'alert');
  }
}

function harden(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.on('will-navigate', (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

/**
 * Ganchos para las pruebas de extremo a extremo (solo en desarrollo, nunca en la versión empaquetada):
 * abren la rueda con archivos concretos sin pasar por el Explorador, que solo existe en Windows.
 */
export interface E2EHooks {
  openForPaths(paths: string[], cursor?: Point): Promise<boolean>;
  /** Usa una imagen fija como escritorio (simula la exclusión de capturas de Windows en Linux). */
  useStaticBackdrop(file: string | null): boolean;
  /** Tamaño de la ventana de la rueda en DIP. */
  wheelWindowSize(): number;
  /** Arranca el servidor del menú contextual en otra ruta (en Linux, un socket local). */
  startMenuServer(socketPath: string): Promise<boolean>;
  wheelWindow(): BrowserWindow | null;
  toastWindow(): BrowserWindow | null;
  /** Abre el panel de ajustes junto a un punto (en las pruebas no hay icono de bandeja fiable). */
  openSettings(at: Point): Promise<void>;
  settingsWindow(): BrowserWindow | null;
  /** Configuración guardada en este momento. */
  config(): AppConfig;
  jobs(): JobManager;
  caps(): EngineCaps;
  quit(): void;
}

function e2eHooks(): E2EHooks {
  return {
    openForPaths: async (paths, at) => openFiles(paths, at),
    useStaticBackdrop: (file) => {
      staticBackdrop = file ? nativeImage.createFromPath(file) : null;
      if (staticBackdrop?.isEmpty()) staticBackdrop = null;
      return staticBackdrop !== null;
    },
    wheelWindowSize: () => WHEEL_WINDOW,
    startMenuServer: (socketPath) => {
      openRequests ??= new OpenRequestServer((paths) => void onMenuRequest(paths));
      return openRequests.start(socketPath);
    },
    wheelWindow: () => wheel.browserWindow(),
    toastWindow: () => toast.browserWindow(),
    openSettings: async (at) => settingsWindow?.open({ x: at.x, y: at.y, width: 1, height: 1 }),
    settingsWindow: () => settingsWindow?.browserWindow() ?? null,
    config: () => config.value,
    jobs: () => jobs,
    caps: () => caps,
    quit: () => app.quit(),
  };
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('es.efc.easyfileconverter');
  // Sin config.json (primera ejecución), el idioma de Windows; el del instalador manda si lo hay.
  config = new ConfigStore(app.getPath('userData'), { language: languageFromLocale(app.getLocale()) });
  initLogger(app.getPath('logs'), { verbose: config.value.verboseLog || !app.isPackaged });
  log.info(`EFC ${app.getVersion()} — Electron ${process.versions.electron}, ${process.platform} ${process.getSystemVersion()}`);
  harden();
  applyInstallerLanguage();

  applyCaptureExclusion();
  caps = { ...caps, text: existsSync(textFontPath()) };
  if (!caps.text) log.warn(`Falta la fuente para TXT → PDF: ${textFontPath()}`);
  const preload = path.join(__dirname, 'preload.cjs');
  worker = new WorkerClient(path.join(__dirname, 'worker.cjs'));
  toast = new ToastWindow({
    preload,
    theme: () => lastTheme,
    language: () => config.value.language,
    onAction: onToastAction,
    onExpire: (id) => jobs.forget(id),
  });
  jobs = new JobManager({
    worker,
    maxConcurrent: () => config.value.maxConcurrentJobs,
    settings: () => config.value.conversion,
    caps: () => caps,
    fontPath: () => textFontPath(),
    officeRunner: () => officeRunner(),
    language: () => config.value.language,
    onChange: (job) => {
      if (job.state === 'cancelled' && !toast.has(job.id) && job.result === null) return;
      toast.upsert(jobToToast(job, config.value.language), job.anchor);
    },
  });
  wheel = new WheelWindow({
    preload,
    windowSize: WHEEL_WINDOW,
    onChoose,
    onClosed: () => {
      openContext = null;
    },
    forceFocus: async (hwnd) => {
      await helper?.request('focus', [hwnd], 800);
    },
  });
  await wheel.ensure().catch(() => undefined);
  void toast.prepare();
  settingsWindow = new SettingsWindow({
    preload,
    state: () => settingsState(),
    fallbackTheme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    failedMessage: () => text().settings.errors.failed,
    capture: async (display, region) => {
      if (!config.value.backdropBlur) return null;
      if (staticBackdrop) return { displayId: display.id, bounds: { ...display.bounds }, image: staticBackdrop };
      const h = helper;
      if (h?.canCapture) {
        const shot = await captureRegion(display, region, (rect, percent) => h.capture(rect, percent), toPhysicalRect);
        if (shot) return shot;
      }
      return captureDisplay(display);
    },
    onChange: (change) => applySettingsChange(change),
    onRecording: (active) => onShortcutRecording(active),
  });

  if (process.platform === 'win32') {
    helper = new ExplorerHelper(helperPaths());
    helper.start().catch((err: unknown) => {
      log.error('No se pudo iniciar el detector del Explorador', err);
      notify(text().notify.detectionTitle, text().notify.detectionNoStart, undefined, 'alert');
    });
  } else {
    log.warn('Sistema distinto de Windows: la integración con el Explorador está desactivada.');
  }

  registerShortcut();
  applyLoginItem();
  refreshTray();

  if (process.platform === 'win32') {
    officeDetection = detectOffice()
      .then((office) => {
        caps = { ...caps, office };
        const found = office ? (Object.keys(office) as OfficeApp[]).filter((a) => office[a]).map((a) => OFFICE_APP_NAMES[a]) : [];
        if (found.length === 0) log.info('Office no está instalado: no se ofrecen Word, Excel ni PowerPoint → PDF');
        else if (!existsSync(officeRunner().script)) {
          caps = { ...caps, office: null };
          log.error(`Falta el script de Office: ${officeRunner().script}`);
        } else log.info(`Office disponible para PDF: ${found.join(', ')}`);
      })
      .catch((err: unknown) => log.warn('No se pudo comprobar si Office está instalado', err));
    openRequests = new OpenRequestServer((paths) => void onMenuRequest(paths));
    void openRequests.start();
    void applyContextMenu();
  }

  void locateFfmpeg(config.value.ffmpegPath).then((found) => {
    caps = { ...caps, ffmpeg: found };
    refreshTray();
  });

  // Autocomprobación de los motores en segundo plano (no retrasa el arranque).
  setTimeout(() => {
    void worker.selfTest().then((report) => {
      caps = { ...caps, image: report.image, pdf: report.pdf };
      if (report.errors.length > 0) log.error('Autocomprobación de motores:', report.errors.join(' | '));
      else log.info(`Motores de imagen y PDF verificados${report.details ? ` (${report.details})` : ''}`);
    });
  }, 6000).unref();

  if (!config.value.welcomeShown) {
    config.update({ welcomeShown: true });
    notify(text().notify.readyTitle, text().notify.howTo(shortcutLabel()));
  }

  const driver = app.isPackaged ? undefined : process.env.EFC_E2E_DRIVER;
  if (driver) {
    log.warn(`Modo de prueba E2E: ${driver}`);
    const mod = require(driver) as { run(hooks: E2EHooks): Promise<void> };
    void mod.run(e2eHooks()).catch((err: unknown) => {
      log.error('Fallo del controlador E2E', err);
      app.exit(1);
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // El lanzador del menú contextual inicia EFC si no estaba en marcha; si ya lo estaba, no se avisa.
    if (argv.includes('--from-menu')) return;
    if (config && toast) notify(text().notify.runningTitle, text().notify.howTo(shortcutLabel()));
  });
  // EFC vive en segundo plano: cerrar sus ventanas no debe terminar la aplicación.
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    helper?.dispose();
    openRequests?.stop();
    jobs?.cancelAll();
    worker?.dispose();
    tray?.hide();
    settingsWindow?.destroy();
    toast?.destroy();
    wheel?.destroy();
    log.info(`EFC cerrado${quitting ? '' : ' (sin before-quit)'}`);
  });
  app
    .whenReady()
    .then(bootstrap)
    .catch((err: unknown) => {
      log.error('Error fatal al iniciar', err);
      app.quit();
    });
}
