import { randomBytes } from 'node:crypto';
import { createReadStream, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Un servidor HTTP de UN solo fichero para que la tele pueda descargar un audio.
 *
 * La tele (LG webOS) reproduce una URL, no bytes: hay que servirle el MP3 por la red
 * de casa. El panel web escucha solo en loopback con token y así debe seguir, de modo
 * que esto es un servidor aparte, mínimo y efímero:
 *  - escucha en la IP del PC que está en la MISMA subred que la tele (nunca 0.0.0.0);
 *  - solo responde a la IP de la tele; cualquier otra recibe 403;
 *  - una única ruta con 128 bits aleatorios; todo lo demás es 404;
 *  - solo GET/HEAD (con Range, que es lo que piden los reproductores de la tele);
 *  - se cierra solo tras `ttlMs` y borra el fichero (es una copia temporal).
 */

export interface NetIface {
  address: string;
  netmask: string;
  family: string | number;
  internal: boolean;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!m) return null;
  const [a = 0, b = 0, c = 0, d = 0] = m.slice(1).map(Number);
  if ([a, b, c, d].some((p) => p > 255)) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/**
 * La IP local desde la que la tele puede alcanzarnos: una IPv4 no interna cuya subred
 * contiene la IP de la tele. Sin coincidencia devuelve null (no se adivina: servir en
 * otra interfaz expondría el fichero donde no toca).
 */
export function pickLanAddress(
  tvHost: string,
  ifaces: Record<string, NetIface[] | undefined> = networkInterfaces() as Record<
    string,
    NetIface[] | undefined
  >,
): string | null {
  const tv = ipv4ToInt(tvHost);
  if (tv === null) return null;
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal || !(i.family === 'IPv4' || i.family === 4)) continue;
      const addr = ipv4ToInt(i.address);
      const mask = ipv4ToInt(i.netmask);
      if (addr === null || mask === null || mask === 0) continue;
      if ((addr & mask) >>> 0 === (tv & mask) >>> 0 && addr !== tv) return i.address;
    }
  }
  return null;
}

/** Normaliza `::ffff:192.168.1.5` a `192.168.1.5` para comparar con la IP de la tele. */
export function normalizeRemote(addr: string | undefined): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export interface ServedFile {
  url: string;
  /** Cierra el servidor y borra el fichero. Idempotente. */
  close(): void;
  /** Se resuelve cuando el servidor se ha cerrado (por ttl o por close()). */
  closed: Promise<void>;
  /** Peticiones servidas con éxito (para pruebas y para el log). */
  hits(): number;
}

export interface ServeOptions {
  file: string;
  /** IP en la que escuchar (la de pickLanAddress). */
  bindIp: string;
  /** Única IP remota aceptada (la tele). */
  allowIp: string;
  mimeType?: string;
  ttlMs?: number;
  /** Para pruebas: puerto fijo. 0 = el que dé el sistema. */
  port?: number;
  /** Borrar el fichero al cerrar. Por defecto sí: es una copia temporal. */
  deleteOnClose?: boolean;
}

const DEFAULT_TTL_MS = 10 * 60_000;

function parseRange(header: string | undefined, size: number): [number, number] | null | 'bad' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'bad';
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return 'bad';
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'bad';
  return [start, end];
}

export function serveFileToHost(opts: ServeOptions): Promise<ServedFile> {
  const token = randomBytes(16).toString('hex');
  const ext = /\.(\w{1,5})$/.exec(opts.file)?.[1] ?? 'bin';
  const route = `/a/${token}.${ext}`;
  const mime = opts.mimeType ?? 'audio/mpeg';
  const allow = normalizeRemote(opts.allowIp);
  let served = 0;
  let closing = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (normalizeRemote(req.socket.remoteAddress) !== allow) {
      res.writeHead(403).end();
      return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (path !== route) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let size: number;
    try {
      size = statSync(opts.file).size;
    } catch {
      res.writeHead(410).end();
      return;
    }
    const range = parseRange(req.headers.range, size);
    if (range === 'bad') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    const headers: Record<string, string | number> = {
      'Content-Type': mime,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    served++;
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    createReadStream(opts.file, { start, end }).pipe(res);
  };

  const server = createServer(handler);
  return new Promise<ServedFile>((resolve, reject) => {
    const close = (): void => {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      server.close(() => resolveClosed());
      server.closeAllConnections?.();
      if (opts.deleteOnClose !== false) rmSync(opts.file, { force: true });
    };
    const timer = setTimeout(close, opts.ttlMs ?? DEFAULT_TTL_MS);
    timer.unref?.();
    server.once('error', (err) => {
      clearTimeout(timer);
      if (opts.deleteOnClose !== false) rmSync(opts.file, { force: true });
      reject(err);
    });
    server.listen(opts.port ?? 0, opts.bindIp, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://${opts.bindIp}:${port}${route}`,
        close,
        closed,
        hits: () => served,
      });
    });
  });
}
