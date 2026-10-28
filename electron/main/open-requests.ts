/**
 * Peticiones «Convertir con EFC» del menú contextual del Explorador.
 *
 * El Explorador ejecuta el lanzador (efc-helper.exe --open "<ruta>") una vez por archivo seleccionado.
 * Cada lanzador envía su ruta por una tubería con nombre local de este usuario; aquí se reúnen las que
 * llegan casi a la vez y se entregan juntas, para abrir una sola rueda con todos los archivos.
 *
 * Lo recibido se trata como no fiable: solo se aceptan cadenas con forma de ruta, con límites de
 * tamaño y número, y después pasan por la misma validación que la selección del Explorador.
 */
import net from 'node:net';
import { createLogger } from './logger';

const log = createLogger('menú');

/** Espera tras el último archivo recibido antes de abrir la rueda. */
const QUIET_MS = 300;
/** Espera máxima desde el primero (selecciones muy grandes). */
const MAX_WAIT_MS = 2500;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_PATHS = 500;

/** Nombre de la tubería: el mismo que calcula el lanzador nativo (USERNAME). */
export function openPipePath(user = process.env.USERNAME ?? 'usuario'): string {
  return `\\\\.\\pipe\\efc-open-${user}`;
}

/** Interpreta un mensaje del lanzador. Devuelve las rutas válidas (o ninguna). */
export function parseOpenMessage(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object' || (data as { v?: unknown }).v !== 1) return [];
  const paths = (data as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length >= 3 && p.length <= 32_000 && !p.includes('\0')).slice(0, MAX_PATHS);
}

/** Reúne rutas que llegan seguidas y las entrega juntas. */
export class OpenBatcher {
  private paths: string[] = [];
  private quiet: NodeJS.Timeout | null = null;
  private limit: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliver: (paths: string[]) => void,
    private readonly quietMs = QUIET_MS,
    private readonly maxWaitMs = MAX_WAIT_MS,
  ) {}

  add(paths: readonly string[]): void {
    for (const p of paths) {
      if (this.paths.length >= MAX_PATHS) break;
      if (!this.paths.some((q) => q.toLowerCase() === p.toLowerCase())) this.paths.push(p);
    }
    if (this.paths.length === 0) return;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.flush(), this.quietMs);
    this.limit ??= setTimeout(() => this.flush(), this.maxWaitMs);
  }

  /** Descarta lo pendiente sin entregarlo (al cerrar EFC). */
  discard(): void {
    this.paths = [];
    this.flush();
  }

  flush(): void {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.limit) clearTimeout(this.limit);
    this.quiet = null;
    this.limit = null;
    const batch = this.paths;
    this.paths = [];
    if (batch.length > 0) this.deliver(batch);
  }
}

export class OpenRequestServer {
  private server: net.Server | null = null;
  private readonly batcher: OpenBatcher;

  constructor(onPaths: (paths: string[]) => void) {
    this.batcher = new OpenBatcher(onPaths);
  }

  start(pipe = openPipePath()): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        let received = '';
        socket.setEncoding('utf8');
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('data', (chunk: string) => {
          received += chunk;
          if (received.length > MAX_MESSAGE_BYTES) socket.destroy();
        });
        socket.on('end', () => {
          for (const line of received.split('\n')) {
            const paths = parseOpenMessage(line.trim());
            if (paths.length > 0) this.batcher.add(paths);
          }
        });
        socket.on('error', () => undefined);
      });
      server.once('error', (err) => {
        log.warn(`No se pudo escuchar en ${pipe}: el menú contextual no funcionará`, err);
        resolve(false);
      });
      server.listen(pipe, () => {
        this.server = server;
        log.info(`Esperando peticiones del menú contextual en ${pipe}`);
        resolve(true);
      });
    });
  }

  stop(): void {
    this.batcher.discard();
    this.server?.close();
    this.server = null;
  }
}
