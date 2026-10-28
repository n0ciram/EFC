/**
 * Acceso a la API de Electron. En desarrollo, si la página se abre en un navegador normal (sin
 * Electron), se usa una simulación para poder diseñar y probar la interfaz; en la compilación de
 * producción la simulación se elimina.
 */
import type { EfcApi } from '../types/ipc';

export async function getApi(): Promise<EfcApi> {
  if (window.efc) return window.efc;
  if (import.meta.env.DEV) {
    const { createMockApi } = await import('./mock-api');
    return createMockApi();
  }
  throw new Error('La API de EFC no está disponible.');
}
