import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { log } from '../log.js';
import { renderManifest, renderPage, renderServiceWorker } from './page.js';

export interface WebUiDeps {
  token: string;
  status(): unknown | Promise<unknown>;
  sessions(query?: string): unknown | Promise<unknown>;
  memory(scope?: string): unknown | Promise<unknown>;
  auditVerify(): unknown | Promise<unknown>;
}

const DEFAULT_HOST = '127.0.0.1';

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

type ApiHandler = () => unknown | Promise<unknown>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setBaseHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  let code = status;
  let body: string;
  try {
    body = JSON.stringify(value) ?? 'null';
  } catch (error) {
    // No se manda el detalle: podría llevar datos internos del objeto.
    log.warn('webui: respuesta no serializable', { error: describeError(error) });
    code = 500;
    body = JSON.stringify({ error: 'Error interno' });
  }
  send(res, code, body, 'application/json; charset=utf-8');
}

function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  const value = match?.[1];
  return value === undefined ? null : value;
}

/**
 * Compara resúmenes SHA-256, no los tokens: timingSafeEqual exige buffers del
 * mismo tamaño y el hash fija esa longitud sin revelar la del secreto.
 */
function tokenMatches(received: string, expected: string): boolean {
  const a = createHash('sha256').update(received, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const received = extractBearer(req);
  return received !== null && tokenMatches(received, token);
}

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

function apiHandler(deps: WebUiDeps, pathname: string, url: URL): ApiHandler | null {
  switch (pathname) {
    case '/api/status':
      return () => deps.status();
    case '/api/sessions': {
      const query = queryParam(url, 'q');
      return () => deps.sessions(query);
    }
    case '/api/memory': {
      const scope = queryParam(url, 'scope');
      return () => deps.memory(scope);
    }
    case '/api/audit/verify':
      return () => deps.auditVerify();
    default:
      return null;
  }
}

async function respondApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUiDeps,
  pathname: string,
  url: URL,
): Promise<void> {
  const handler = apiHandler(deps, pathname, url);
  if (!handler) {
    sendJson(res, 404, { error: 'No encontrado' });
    return;
  }
  if (!authorized(req, deps.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="asistenta"');
    sendJson(res, 401, { error: 'No autorizado' });
    return;
  }
  let payload: unknown;
  try {
    payload = await handler();
  } catch (error) {
    // El cliente recibe un 500 opaco; el detalle solo va al registro local.
    log.warn('webui: fallo una dependencia', {
      ruta: pathname,
      error: describeError(error),
    });
    sendJson(res, 500, { error: 'Error interno' });
    return;
  }
  sendJson(res, 200, payload);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUiDeps,
): Promise<void> {
  setBaseHeaders(res);
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const apiPath = pathname === '/api' || pathname.startsWith('/api/');

  if (apiPath) {
    res.setHeader('Cache-Control', 'no-store');
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: 'Método no permitido' });
      return;
    }
    await respondApi(req, res, deps, pathname, url);
    return;
  }

  if (method !== 'GET') {
    send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    return;
  }

  switch (pathname) {
    case '/':
      res.setHeader('Content-Security-Policy', PAGE_CSP);
      res.setHeader('Cache-Control', 'no-store');
      send(res, 200, renderPage(), 'text/html; charset=utf-8');
      return;
    case '/manifest.webmanifest':
      res.setHeader('Cache-Control', 'no-cache');
      send(res, 200, renderManifest(), 'application/manifest+json; charset=utf-8');
      return;
    case '/sw.js':
      res.setHeader('Cache-Control', 'no-cache');
      send(res, 200, renderServiceWorker(), 'text/javascript; charset=utf-8');
      return;
    default:
      send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
  }
}

function assertLoopbackHost(host: string): void {
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return;
  throw new Error('startWebUi: el host debe ser de loopback');
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function startWebUi(
  deps: WebUiDeps,
  opts?: { port?: number; host?: string },
): Promise<{ url: string; close(): Promise<void> }> {
  if (deps.token.trim().length === 0) {
    throw new Error('startWebUi: falta el token del panel');
  }
  const port = opts?.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('startWebUi: puerto inválido');
  }
  const host = opts?.host?.trim() || DEFAULT_HOST;
  assertLoopbackHost(host);

  const server = createServer((req, res) => {
    void handleRequest(req, res, deps).catch((error: unknown) => {
      log.warn('webui: error no controlado', { error: describeError(error) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      setBaseHeaders(res);
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 500, { error: 'Error interno' });
    });
  });
  server.keepAliveTimeout = 5_000;

  try {
    await listen(server, port, host);
  } catch (error) {
    server.close();
    throw error;
  }

  // Un error posterior al listen no debe tumbar el proceso por falta de listener.
  server.on('error', (error) => {
    log.warn('webui: error del servidor', { error: describeError(error) });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw new Error('startWebUi: no se pudo leer el puerto asignado');
  }
  const shownHost = address.address.includes(':') ? `[${address.address}]` : address.address;
  const url = `http://${shownHost}:${address.port}`;

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      server.close((error) => {
        if (timer !== undefined) clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      // Los keep-alive inactivos se cierran ya; una petición en vuelo tiene un
      // margen corto antes de que se destruyan sus sockets.
      server.closeIdleConnections();
      timer = setTimeout(() => server.closeAllConnections(), 500);
      timer.unref?.();
    });
    return closing;
  };

  return { url, close };
}
