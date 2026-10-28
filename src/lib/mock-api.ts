/**
 * Simulación de la API de Electron para diseñar la interfaz en un navegador (solo en desarrollo).
 * Dibuja un escritorio de ejemplo con una ventana del Explorador para comprobar el cristal, el
 * contraste y las animaciones. Parámetros de la URL:
 *   ?scene=light|dark|wallpaper  &scenario=png|pdf|video|audio|multi|many|long|single|notice
 *   &toast=running|indeterminate|done|error|batch|stack|info  &autoplay=0  &nobackdrop=1
 *   &transparency=0–100 (rueda)  &lang=es|en   settings.html: &error=1 (aviso de atajo ocupado)
 */
import type { Language } from '../i18n';
import type { IconId, TargetId } from '../types/formats';
import type { EfcApi, SettingsState, SettingsValues, ThemeName, ToastItem, ToastState, WheelBackdrop, WheelCloseReason, WheelState, WheelTarget } from '../types/ipc';

const params = new URLSearchParams(location.search);
const mockLanguage: Language = params.get('lang') === 'en' ? 'en' : 'es';
const SCENE_W = 1280;
const SCENE_H = 800;

interface Scene {
  canvas: HTMLCanvasElement;
  theme: ThemeName;
}

function drawScene(kind: string): Scene {
  const canvas = document.createElement('canvas');
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  if (kind === 'wallpaper') {
    const g = ctx.createLinearGradient(0, 0, SCENE_W, SCENE_H);
    g.addColorStop(0, '#f2a93b');
    g.addColorStop(0.45, '#ef5b3f');
    g.addColorStop(1, '#7d6bd6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SCENE_W, SCENE_H);
    drawIcons(ctx, 'light-text');
    return { canvas, theme: 'light' };
  }

  const dark = kind === 'dark';
  const wall = ctx.createLinearGradient(0, 0, SCENE_W, SCENE_H);
  wall.addColorStop(0, dark ? '#1d2a44' : '#9fb7d6');
  wall.addColorStop(1, dark ? '#3a2340' : '#dfe7f1');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, SCENE_W, SCENE_H);

  // Ventana del Explorador
  const x = 140;
  const y = 70;
  const w = 1000;
  const h = 640;
  ctx.fillStyle = dark ? '#202020' : '#ffffff';
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.fillStyle = dark ? '#2b2b2b' : '#f3f3f3';
  ctx.fillRect(x, y, w, 86);
  ctx.fillStyle = dark ? '#262626' : '#f7f7f7';
  ctx.fillRect(x, y + 86, 200, h - 86);
  ctx.font = '13px Inter, "Segoe UI", sans-serif';
  ctx.fillStyle = dark ? '#dddddd' : '#1a1a1a';
  ctx.fillText('Este equipo  ›  Documentos  ›  Proyecto', x + 20, y + 58);
  const nav = ['Inicio', 'Galería', 'Escritorio', 'Descargas', 'Documentos', 'Imágenes', 'Música', 'Vídeos'];
  nav.forEach((n, i) => ctx.fillText(n, x + 26, y + 124 + i * 30));
  const files: [string, string][] = [
    ['Informe trimestral.pdf', '#d9473b'],
    ['logo-empresa.png', '#3f8ad8'],
    ['foto vacaciones 2026.jpg', '#4ca66b'],
    ['presentación final.pptx', '#d8752b'],
    ['boletín octubre.docx', '#2f63c0'],
    ['grabación reunión.mp4', '#7a4fc4'],
    ['entrevista.wav', '#b0447e'],
    ['planos nave.tiff', '#4a9fa6'],
    ['captura pantalla.webp', '#888888'],
    ['presupuesto.xlsx', '#2f8a4c'],
    ['icono.svg', '#d4a32a'],
    ['notas.txt', '#777777'],
    ['escaneo albarán.pdf', '#d9473b'],
    ['banner web.avif', '#3f8ad8'],
    ['animación.gif', '#4ca66b'],
    ['audio podcast.mp3', '#b0447e'],
  ];
  files.forEach(([name, color], i) => {
    const ry = y + 112 + i * 33;
    if (i === 2) {
      ctx.fillStyle = dark ? '#3a4a5e' : '#cce4f7';
      ctx.fillRect(x + 210, ry - 20, w - 230, 30);
    }
    ctx.fillStyle = color;
    roundRect(ctx, x + 222, ry - 15, 18, 20, 3);
    ctx.fill();
    ctx.fillStyle = dark ? '#e8e8e8' : '#1a1a1a';
    ctx.fillText(name, x + 252, ry);
    ctx.fillStyle = dark ? '#9a9a9a' : '#6b6b6b';
    ctx.fillText('24/10/2026 9:4' + (i % 10), x + 600, ry);
    ctx.fillText(`${(i * 1.7 + 0.4).toFixed(1).replace('.', ',')} MB`, x + 820, ry);
  });
  return { canvas, theme: dark ? 'dark' : 'light' };
}

function drawIcons(ctx: CanvasRenderingContext2D, _mode: string): void {
  ctx.font = '12px Inter, "Segoe UI", sans-serif';
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(ctx, 1180, 40 + i * 90, 44, 54, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(`archivo ${i + 1}`, 1170, 112 + i * 90);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function crop(scene: HTMLCanvasElement, x: number, y: number, w: number, h: number, scale = 1): string {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.drawImage(scene, x, y, w, h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

/** Pone como fondo de la página la parte del escritorio que habría detrás de la ventana. */
function paintDesktopBehind(scene: HTMLCanvasElement, originX: number, originY: number): void {
  const url = crop(scene, originX, originY, window.innerWidth, window.innerHeight);
  document.documentElement.style.background = `url(${url}) no-repeat 0 0 / ${window.innerWidth}px ${window.innerHeight}px`;
}

const T = (id: TargetId, label: string, description: string, icon: IconId): WheelTarget => ({ id, label, description, icon });
const IMAGE_TARGETS: WheelTarget[] = [
  T('jpg', 'JPG', 'Imagen JPEG', 'photo'),
  T('webp', 'WEBP', 'Imagen WebP', 'web'),
  T('pdf', 'PDF', 'Documento PDF', 'document'),
  T('ico', 'ICO', 'Icono de Windows', 'app'),
  T('avif', 'AVIF', 'Imagen AVIF', 'sparkle'),
  T('tiff', 'TIFF', 'Imagen TIFF', 'layers'),
  T('bmp', 'BMP', 'Mapa de bits', 'grid'),
  T('gif', 'GIF', 'Imagen GIF', 'frames'),
];

function scenarioState(name: string): Omit<WheelState, 'token' | 'theme' | 'backdrop' | 'diameter' | 'transparency' | 'language'> {
  switch (name) {
    case 'pdf':
      return {
        title: 'Informe trimestral.pdf',
        sourceLabel: 'PDF',
        sizeLabel: '1,1 MB',
        count: 1,
        notice: null,
        targets: [
          T('jpg', 'JPG', 'Páginas en JPG', 'photo'),
          { ...T('shrink', 'REDUCIR', 'PDF más ligero', 'shrink'), group: 'pdf-tools' as const },
          { ...T('pdf-split', 'SEPARAR', 'Un PDF por página', 'split'), group: 'pdf-tools' as const },
          { ...T('pdf-rotate', 'GIRAR', 'Girar 90° a la derecha', 'rotate'), group: 'pdf-tools' as const },
          T('png', 'PNG', 'Páginas en PNG', 'photo-alpha'),
          T('txt', 'TXT', 'Extraer el texto', 'text'),
          T('webp', 'WEBP', 'Páginas en WEBP', 'web'),
          T('tiff', 'TIFF', 'Páginas en TIFF', 'layers'),
        ],
      };
    case 'video':
      return {
        title: 'grabación reunión.mp4',
        sourceLabel: 'MP4',
        sizeLabel: '284 MB',
        count: 1,
        notice: null,
        targets: [T('mp3', 'MP3', 'Extraer audio MP3', 'note'), T('gif', 'GIF', 'Imagen GIF', 'frames'), T('webm', 'WEBM', 'Vídeo WebM (VP9)', 'web'), T('mov', 'MOV', 'Vídeo QuickTime', 'film'), T('mkv', 'MKV', 'Vídeo Matroska', 'film'), T('m4a', 'M4A', 'Extraer audio M4A', 'note'), T('wav', 'WAV', 'Extraer audio WAV', 'wave')],
      };
    case 'audio':
      return {
        title: 'entrevista.wav',
        sourceLabel: 'WAV',
        sizeLabel: '48,2 MB',
        count: 1,
        notice: null,
        targets: [T('mp3', 'MP3', 'Audio MP3', 'note'), T('flac', 'FLAC', 'Audio FLAC sin pérdidas', 'wave-lossless'), T('m4a', 'M4A', 'Audio AAC (M4A)', 'note'), T('ogg', 'OGG', 'Audio Ogg Vorbis', 'waves'), T('opus', 'OPUS', 'Audio Opus', 'waves')],
      };
    case 'multi':
      return {
        title: '6 archivos',
        sourceLabel: 'PNG · JPG',
        sizeLabel: '18,4 MB',
        count: 6,
        notice: null,
        targets: [...IMAGE_TARGETS.slice(0, 3), T('pdf-merge', 'UNIR', 'Un solo PDF con todas', 'merge'), T('png', 'PNG', 'Imagen PNG', 'photo-alpha'), ...IMAGE_TARGETS.slice(3)],
      };
    case 'long':
      return { title: 'Presupuesto_definitivo_cliente_Valencia_revisión_final_v12_firmado.png', sourceLabel: 'PNG', sizeLabel: '3,7 MB', count: 1, notice: null, targets: IMAGE_TARGETS };
    case 'single':
      return { title: 'icono.svg', sourceLabel: 'SVG', sizeLabel: '4 KB', count: 1, notice: null, targets: [T('png', 'PNG', 'Imagen PNG', 'photo-alpha')] };
    case 'two':
      return { title: 'notas.pdf', sourceLabel: 'PDF', sizeLabel: '24 KB', count: 1, notice: null, targets: [T('jpg', 'JPG', 'Páginas en JPG', 'photo'), T('txt', 'TXT', 'Extraer el texto', 'text')] };
    case 'notice':
      return { title: 'foto.png', sourceLabel: 'JPG', sizeLabel: '2,1 MB', count: 1, notice: 'El contenido es JPG aunque la extensión diga otra cosa.', targets: IMAGE_TARGETS.slice(1) };
    case 'png':
    default:
      return { title: 'logo-empresa.png', sourceLabel: 'PNG', sizeLabel: '1,2 MB', count: 1, notice: null, targets: [...IMAGE_TARGETS, { ...T('shrink', 'REDUCIR', 'Más ligera, para enviar', 'shrink'), group: 'image-tools' as const }] };
  }
}

function toastScenario(name: string): ToastItem[] {
  const base = { icon: 'photo' as IconId };
  switch (name) {
    case 'indeterminate':
      return [{ id: 'a', status: 'running', title: 'Convirtiendo a AVIF', detail: 'logo-empresa.png', meta: '0 de 1 procesados', progress: null, actions: ['cancel'], ...base }];
    case 'done':
      return [{ id: 'a', status: 'done', title: 'Guardado', detail: 'logo-empresa.jpg', meta: '1 de 1 procesados', progress: 1, icon: 'check', actions: ['reveal', 'dismiss'] }];
    case 'error':
      return [{ id: 'a', status: 'error', title: 'No se pudo convertir', detail: 'dañado.png: El archivo está dañado o no tiene un formato válido.', progress: null, icon: 'alert', actions: ['retry', 'dismiss'] }];
    case 'batch':
      return [{ id: 'a', status: 'running', title: 'Convirtiendo a WEBP', detail: 'foto 4.jpg', meta: '3 de 6 procesados · 58\u00a0%', progress: 0.58, actions: ['cancel'], icon: 'web' }];
    case 'info':
      return [{ id: 'a', status: 'info', title: 'Sin conversiones disponibles', detail: 'FFmpeg no está disponible: no se puede convertir MP4.', progress: null, icon: 'info', actions: ['dismiss'] }];
    case 'stack':
      return [
        { id: 'a', status: 'running', title: 'Convirtiendo páginas a JPG', detail: 'Informe trimestral.pdf', meta: '5 de 12 páginas · 42\u00a0%', progress: 0.42, actions: ['cancel'], icon: 'photo' },
        { id: 'b', status: 'done', title: 'Guardado', detail: 'entrevista.mp3', progress: 1, icon: 'check', actions: ['reveal', 'dismiss'] },
        { id: 'c', status: 'error', title: '4 de 5 convertidos', detail: 'roto.png: El archivo está dañado o no tiene un formato válido.', progress: null, icon: 'alert', actions: ['retry', 'reveal', 'dismiss'] },
      ];
    case 'running':
    default:
      return [{ id: 'a', status: 'running', title: 'Convirtiendo a JPG', detail: 'logo-empresa.png', meta: '0 de 1 procesados · 35\u00a0%', progress: 0.35, actions: ['cancel'], ...base }];
  }
}

declare global {
  interface Window {
    __efcMock?: {
      open(scenario?: string): void;
      dismiss(reason?: WheelCloseReason): void;
      setToasts(name: string): void;
      events: string[];
    };
  }
}

export function createMockApi(): EfcApi {
  const sceneName = params.get('scene') ?? 'light';
  const scene = drawScene(sceneName);
  const isToast = location.pathname.includes('toast');
  const isSettings = location.pathname.includes('settings');
  // Posición de la ventana simulada dentro del escritorio.
  const originX = Number(params.get('x') ?? (isToast ? 330 : 380));
  const originY = Number(params.get('y') ?? (isToast ? 240 : 150));
  paintDesktopBehind(scene.canvas, originX, originY);
  const noBackdrop = params.get('nobackdrop') === '1';
  const backdropFor = (w: number, h: number, margin: number): WheelBackdrop | null =>
    noBackdrop
      ? null
      : { dataUrl: crop(scene.canvas, originX - margin, originY - margin, w + margin * 2, h + margin * 2, 0.5), x: -margin, y: -margin, width: w + margin * 2, height: h + margin * 2 };

  const events: string[] = [];
  const listeners = {
    open: new Set<(s: WheelState) => void>(),
    play: new Set<(t: number) => void>(),
    dismiss: new Set<(r: WheelCloseReason) => void>(),
    toast: new Set<(s: ToastState) => void>(),
    settings: new Set<(s: SettingsState) => void>(),
    settingsDismiss: new Set<() => void>(),
  };
  let settingsValues: SettingsValues = {
    shortcut: 'CommandOrControl+Shift+E',
    launchAtLogin: true,
    contextMenu: true,
    language: mockLanguage,
    backdropBlur: true,
    wheelTransparency: 50,
    excludeFromScreenCapture: true,
    imageQuality: 'high',
    pdfDpi: 200,
    shrinkMaxSide: 1920,
    shrinkVideoMaxSide: 1280,
  };
  let settingsLabel = 'Ctrl + Mayús + E';
  const settingsState = (): SettingsState => ({
    token: 1,
    visible: true,
    theme: (params.get('theme') as ThemeName | null) ?? scene.theme,
    backdrop: backdropFor(window.innerWidth, window.innerHeight, 0),
    values: settingsValues,
    shortcutLabel: settingsLabel,
    shortcutOk: true,
    available: { launchAtLogin: true, contextMenu: true, captureExclusion: true },
    status: 'FFmpeg 6.1.1 · Office: Word, Excel, PowerPoint',
    version: '1.5.0',
    error: params.get('error') === '1' ? { key: 'shortcut', message: 'Esa combinación ya la usa otra aplicación. Prueba otra.' } : null,
  });
  let token = 0;
  const autoplay = params.get('autoplay') !== '0';

  const open = (scenario = params.get('scenario') ?? 'png'): void => {
    token++;
    const state: WheelState = {
      token,
      theme: (params.get('theme') as ThemeName | null) ?? scene.theme,
      backdrop: backdropFor(window.innerWidth, window.innerHeight, 40),
      diameter: 300,
      transparency: Number(params.get('transparency') ?? 50),
      language: mockLanguage,
      ...scenarioState(scenario),
    };
    listeners.open.forEach((cb) => cb(state));
  };

  const toastState = (name: string): ToastState => ({
    items: toastScenario(name),
    theme: (params.get('theme') as ThemeName | null) ?? scene.theme,
    backdrop: backdropFor(window.innerWidth, window.innerHeight, 0),
    language: mockLanguage,
  });

  window.__efcMock = {
    open,
    dismiss: (reason = 'outside') => listeners.dismiss.forEach((cb) => cb(reason)),
    setToasts: (name) => listeners.toast.forEach((cb) => cb(toastState(name))),
    events,
  };

  const sub = <T>(set: Set<(v: T) => void>, cb: (v: T) => void): (() => void) => {
    set.add(cb);
    return () => set.delete(cb);
  };

  setTimeout(() => {
    if (isSettings) {
      listeners.settings.forEach((cb) => cb(settingsState()));
    } else if (isToast) {
      const name = params.get('toast') ?? 'running';
      listeners.toast.forEach((cb) => cb(toastState(name)));
    } else if (autoplay) open();
  }, 60);

  return {
    wheel: {
      onOpen: (cb) => sub(listeners.open, cb),
      onPlay: (cb) => sub(listeners.play, cb),
      onDismiss: (cb) => sub(listeners.dismiss, cb),
      ready: (t) => {
        events.push(`ready:${t}`);
        setTimeout(() => listeners.play.forEach((cb) => cb(t)), 16);
      },
      choose: (t, id) => {
        events.push(`choose:${t}:${id}`);
      },
      requestClose: (t, reason) => {
        events.push(`close:${t}:${reason}`);
      },
      closed: (t) => {
        events.push(`closed:${t}`);
      },
      setInteractive: (v) => {
        events.push(`interactive:${v}`);
      },
    },
    toast: {
      onState: (cb) => sub(listeners.toast, cb),
      action: (id, action) => events.push(`toast:${id}:${action}`),
      setInteractive: (v) => events.push(`toast-interactive:${v}`),
      resize: (h) => events.push(`resize:${h}`),
      hidden: () => events.push('hidden'),
    },
    settings: {
      onState: (cb) => sub(listeners.settings, cb),
      onDismiss: (cb) => sub(listeners.settingsDismiss, cb),
      set: (change) => {
        events.push(`settings:${change.key}=${String(change.value)}`);
        settingsValues = { ...settingsValues, [change.key]: change.value };
        if (change.key === 'shortcut') settingsLabel = String(change.value).replace('CommandOrControl', 'Ctrl').replace('Shift', 'Mayús').replaceAll('+', ' + ');
        listeners.settings.forEach((cb) => cb(settingsState()));
      },
      recording: (v) => events.push(`settings-recording:${v}`),
      close: () => {
        events.push('settings-close');
        listeners.settingsDismiss.forEach((cb) => cb());
      },
      hidden: () => events.push('settings-hidden'),
      resize: (h) => events.push(`settings-resize:${h}`),
    },
  };
}
