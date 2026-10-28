import type { EfcApi } from './ipc';

declare global {
  interface Window {
    /** API segura expuesta por el script de precarga (ausente en un navegador normal). */
    readonly efc?: EfcApi;
  }

  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly PROD: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
