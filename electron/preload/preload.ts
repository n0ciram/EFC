/**
 * Script de precarga: expone a la interfaz una API mínima y tipada (`window.efc`).
 *
 * - Se ejecuta con aislamiento de contexto y en el sandbox de Chromium.
 * - La interfaz no tiene acceso a Node ni a `ipcRenderer`: solo a estas funciones concretas.
 * - Ninguna función acepta rutas: la interfaz solo envía identificadores que el proceso principal valida.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { TargetId } from '../../src/types/formats';
import { IPC, type EfcApi, type SettingsChange, type SettingsState, type ToastAction, type ToastState, type WheelCloseReason, type WheelState } from '../../src/types/ipc';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const TOAST_ACTIONS: readonly ToastAction[] = ['cancel', 'retry', 'dismiss', 'reveal'];

const api: EfcApi = {
  wheel: {
    onOpen: (callback) => subscribe<WheelState>(IPC.wheelOpen, callback),
    onPlay: (callback) => subscribe<number>(IPC.wheelPlay, callback),
    onDismiss: (callback) => subscribe<WheelCloseReason>(IPC.wheelDismiss, callback),
    ready: (token) => ipcRenderer.send(IPC.wheelReady, Number(token)),
    choose: (token, targetId: TargetId) => ipcRenderer.send(IPC.wheelChoose, Number(token), String(targetId)),
    requestClose: (token, reason) => ipcRenderer.send(IPC.wheelRequestClose, Number(token), String(reason)),
    closed: (token) => ipcRenderer.send(IPC.wheelClosed, Number(token)),
    setInteractive: (interactive) => ipcRenderer.send(IPC.wheelInteractive, Boolean(interactive)),
  },
  toast: {
    onState: (callback) => subscribe<ToastState>(IPC.toastState, callback),
    action: (id, action) => {
      if (TOAST_ACTIONS.includes(action)) ipcRenderer.send(IPC.toastAction, String(id), action);
    },
    setInteractive: (interactive) => ipcRenderer.send(IPC.toastInteractive, Boolean(interactive)),
    resize: (height) => ipcRenderer.send(IPC.toastResize, Math.round(Number(height)) || 0),
    hidden: () => ipcRenderer.send(IPC.toastHidden),
  },
  settings: {
    onState: (callback) => subscribe<SettingsState>(IPC.settingsState, callback),
    onDismiss: (callback) => subscribe<void>(IPC.settingsDismiss, () => callback()),
    set: (change: SettingsChange) => {
      // Solo valores simples: el proceso principal comprueba además la clave y el valor.
      const value: unknown = change.value;
      if (['string', 'number', 'boolean'].includes(typeof value)) ipcRenderer.send(IPC.settingsSet, { key: String(change.key), value });
    },
    recording: (active) => ipcRenderer.send(IPC.settingsRecording, Boolean(active)),
    close: () => ipcRenderer.send(IPC.settingsClose),
    hidden: () => ipcRenderer.send(IPC.settingsHidden),
    resize: (height) => ipcRenderer.send(IPC.settingsResize, Math.round(Number(height)) || 0),
  },
};

contextBridge.exposeInMainWorld('efc', api);
