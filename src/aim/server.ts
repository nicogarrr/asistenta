import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import { type RawData, WebSocketServer } from 'ws';
import { makeSelfSignedCert } from './cert.js';
import { AimEngine, type AimInput, type AimSink } from './engine.js';
import { aimPage } from './page.js';

const PRIVATE =
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|::1$|fe80:|::ffff:(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.))/i;

/** Solo la red de casa: nadie de fuera puede mover el ratón. */
export function isLanAddress(addr: string | undefined): boolean {
  return !!addr && PRIVATE.test(addr);
}

export const AIM_MSG_MAX = 512;
export const AIM_MAX_FAILURES = 5;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const triple = (v: unknown): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const a = num(v[0]);
  const b = num(v[1]);
  const c = num(v[2]);
  return a === null || b === null || c === null ? null : [a, b, c];
};

/** Valida un mensaje del móvil; lo que no encaja se descarta (nunca llega al ratón). */
export function parseAimMessage(raw: string): AimInput | null {
  if (raw.length > AIM_MSG_MAX) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const m = o as Record<string, unknown>;
  switch (m.k) {
    case 'm': {
      const t = num(m.t);
      const g = triple(m.g);
      const r = triple(m.r);
      return t === null || !g || !r ? null : { k: 'm', t, g, r };
    }
    case 'down':
    case 'up': {
      const t = num(m.t);
      return t === null ? null : { k: m.k, t };
    }
    case 'scroll': {
      const dy = num(m.dy);
      return dy === null ? null : { k: 'scroll', dy };
    }
    case 'right':
    case 'center':
      return { k: m.k };
    case 'pause':
      return typeof m.on === 'boolean' ? { k: 'pause', on: m.on } : null;
    case 'invert': {
      const out: AimInput = { k: 'invert' };
      if (typeof m.el === 'boolean') out.el = m.el;
      if (typeof m.az === 'boolean') out.az = m.az;
      return out;
    }
    default:
      return null;
  }
}

export interface AimServerOptions {
  sink: AimSink;
  /** IPs LAN del PC (van al certificado). */
  ips: string[];
  port?: number;
  token?: string;
  host?: string;
  log?: (line: string) => void;
}

export interface AimServer {
  port: number;
  token: string;
  server: Server;
  engine: AimEngine;
  close(): Promise<void>;
}

function tokenOk(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startAimServer(opts: AimServerOptions): Promise<AimServer> {
  const token = opts.token ?? randomBytes(6).toString('hex');
  const log = opts.log ?? (() => {});
  const { cert, key } = makeSelfSignedCert(opts.ips);
  const engine = new AimEngine(opts.sink);
  let failures = 0;
  let active: import('ws').WebSocket | null = null;

  const check = (req: IncomingMessage): boolean => {
    if (failures >= AIM_MAX_FAILURES) return false;
    if (!isLanAddress(req.socket.remoteAddress)) return false;
    const url = new URL(req.url ?? '/', 'https://x');
    const ok = tokenOk(url.searchParams.get('t'), token);
    if (!ok) {
      failures += 1;
      log(`Intento con clave incorrecta (${failures}/${AIM_MAX_FAILURES}).`);
    }
    return ok;
  };

  const server = createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    if (url.pathname !== '/' || !check(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('No');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(aimPage());
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: AIM_MSG_MAX });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'https://x');
    if (url.pathname !== '/ws' || !check(req) || active) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      active = ws;
      log('Móvil conectado.');
      ws.on('message', (data: RawData) => {
        const msg = parseAimMessage(data.toString());
        if (msg) engine.handle(msg);
      });
      ws.on('close', () => {
        engine.stop();
        active = null;
        log('Móvil desconectado.');
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8443, opts.host ?? '0.0.0.0', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 8443);
  return {
    port,
    token,
    server,
    engine,
    close: () =>
      new Promise<void>((resolve) => {
        engine.stop();
        active?.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
