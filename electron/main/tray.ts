/**
 * Icono discreto en el área de notificación: única forma visible de EFC mientras está inactivo.
 * Su menú abre los ajustes y el registro, o cierra EFC. Se puede ocultar con `"trayIcon": false` en
 * config.json.
 */
import { Menu, nativeImage, nativeTheme, Tray, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import type { Messages } from '../../src/i18n';
import type { Rect } from './placement';

export interface TrayModel {
  shortcutLabel: string;
  shortcutOk: boolean;
  text: Messages['tray'];
}

export interface TrayActions {
  openSettings(): void;
  openLog(): void;
  quit(): void;
}

export class AppTray {
  private tray: Tray | null = null;

  constructor(
    private readonly iconsDir: string,
    private readonly actions: TrayActions,
  ) {
    nativeTheme.on('updated', () => this.updateIcon());
  }

  private iconPath(): string {
    // Icono claro sobre barra de tareas oscura y viceversa.
    const theme = nativeTheme as unknown as {
      shouldUseDarkColorsForSystemIntegratedUI?: boolean;
    };
    const darkTaskbar = theme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors;
    const file = process.platform === 'win32' ? `tray-${darkTaskbar ? 'light' : 'dark'}.ico` : `tray-${darkTaskbar ? 'light' : 'dark'}.png`;
    return path.join(this.iconsDir, file);
  }

  private updateIcon(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const image = nativeImage.createFromPath(this.iconPath());
    if (!image.isEmpty()) this.tray.setImage(image);
  }

  show(model: TrayModel): void {
    if (!this.tray || this.tray.isDestroyed()) {
      this.tray = new Tray(nativeImage.createFromPath(this.iconPath()));
      // Un clic normal en el icono también abre los ajustes.
      this.tray.on('click', () => this.actions.openSettings());
    }
    const t = model.text;
    this.tray.setToolTip(`EFC — ${model.shortcutOk ? model.shortcutLabel : t.tooltipBusy}`);
    const template: MenuItemConstructorOptions[] = [
      { label: 'EFC — Easy File Converter', enabled: false },
      {
        label: model.shortcutOk ? t.shortcut(model.shortcutLabel) : t.shortcutBusy(model.shortcutLabel),
        enabled: false,
      },
      { type: 'separator' },
      { label: t.settings, click: () => this.actions.openSettings() },
      {
        label: t.log,
        click: () => this.actions.openLog(),
      },
      { type: 'separator' },
      { label: t.quit, click: () => this.actions.quit() },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  /** Posición del icono en pantalla (DIP), o `null` si Windows no la da (p. ej. iconos ocultos). */
  bounds(): Rect | null {
    if (!this.tray || this.tray.isDestroyed()) return null;
    const b = this.tray.getBounds();
    return b.width > 0 && b.height > 0 ? b : null;
  }

  hide(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
