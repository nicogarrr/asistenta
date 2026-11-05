import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { log } from '../log.js';
import { createServer } from '../node-http.js';
import { panelFunciones } from './funciones-view.js';
import { renderManifest, renderPage, renderServiceWorker } from './page.js';

/** Archivos que /api/chat deja pasar al panel (ver panel-chat.ts PANEL_FILE_TYPES). */
const PANEL_FILE_URL =
  /^data:(application\/pdf|application\/epub\+zip|video\/mp4|audio\/ogg|audio\/mpeg|application\/octet-stream);base64,[A-Za-z0-9+/=]*$/;

/** Decisiones que acepta una aprobacion del panel. */
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny';

export interface WebUiDeps {
  token: string;
  status(): unknown | Promise<unknown>;
  sessions(query?: string): unknown | Promise<unknown>;
  memory(scope?: string): unknown | Promise<unknown>;
  /** Ámbitos de memoria existentes, para el selector del panel. Si falta, la ruta responde 503. */
  memoryScopes?(): unknown | Promise<unknown>;
  /**
   * Ámbito que lee /api/memory sin `scope` (p. ej. el privado del dueño). Si está,
   * /api/memory/scopes responde `{ ambitos, porDefecto }` en vez de la lista sola.
   */
  memoryDefaultScope?(): string | undefined;
  auditVerify(): unknown | Promise<unknown>;
  /** Read-only goals, filtered to the configured owner by the caller. */
  goals?(): unknown | Promise<unknown>;
  /** Rutinas programadas del dueño (solo lectura). Si falta o devuelve null, la ruta responde 503. */
  routines?(): unknown | Promise<unknown>;
  /** Tablero de tareas de la semana del dueño (solo lectura). Si falta o devuelve null, 503. */
  tareas?(): unknown | Promise<unknown>;
  /** Paquetes en camino según los correos de envío (solo lectura). Si falta o devuelve null, 503. */
  repartos?(): unknown | Promise<unknown>;
  /** Tarjeta «Páginas»: páginas vivas y salidas de rutinas (paginas-vivas.ts). Si falta, 503. */
  paginas?(): unknown | Promise<unknown>;
  /** Una página en bloques de texto; null/undefined = no existe (404). Si falta, 503. */
  pagina?(id: string): unknown | Promise<unknown>;
  /** Un archivo generado (gráfica, Excel, PDF…) para bajarlo desde «Páginas»; null = 404. */
  creado?(id: string): { bytes: Buffer; mime: string; nombre: string } | null;
  /**
   * Tarjeta «Contexto»: de qué está hecho el contexto de cada conversación abierta
   * (solo números y nombres, ver contexto.ts). Si falta o devuelve null, 503.
   */
  contexto?(): unknown | Promise<unknown>;
  /**
   * Tarjeta «Mapa de memoria»: recuerdos del ámbito (como /api/memory) y sus enlaces,
   * con tope (ver mapa-memoria.ts). Si falta o devuelve null, 503.
   */
  mapaMemoria?(scope?: string): unknown | Promise<unknown>;
  /** Chat libre desde el panel. Si falta, la ruta responde 503. */
  chat?(
    text: string,
  ): Promise<{ text: string; images?: string[]; files?: { name: string; url: string }[] }>;
  /**
   * «Reintentar» del panel: repite el último mensaje del hilo principal sin la
   * respuesta anterior (como /reintentar). `null` = no hay nada que repetir (409);
   * `'con-fotos'` = el último mensaje llevaba fotos y solo se repite desde Telegram (409).
   * Si falta, la ruta responde 503.
   */
  retry?(): Promise<
    | {
        text: string;
        images?: string[];
        files?: { name: string; url: string }[];
      }
    | null
    | 'con-fotos'
  >;
  /** Aprobaciones pendientes. Si falta, la ruta responde 503. */
  approvals?(): unknown;
  /** Aplica una decision a una aprobacion. Si falta, la ruta responde 503. */
  /** `false` = ya no estaba pendiente (caducada, resuelta o desconocida). */
  approve?(id: string, decision: ApprovalDecision): Promise<unknown>;
  /**
   * Selector de modelo de la tarjeta Estado (solo opciones de coste cero
   * verificadas, ver modelos-panel.ts). Si falta, la ruta responde 503.
   */
  setModelo?(id: string): Promise<unknown>;
  /**
   * Campo «Clave de OpenCode Go» de la tarjeta Estado: valida la clave en vivo
   * y la guarda en el almacén (clave-panel.ts). Si falta, la ruta responde 503.
   */
  setClave?(clave: string): Promise<unknown>;
}

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const DECISIONS = new Set<ApprovalDecision>(['once', 'session', 'always', 'deny']);

/** Respuesta a «Siempre/Por ahora» sobre una aprobación que solo admite «una vez». */
export const ONCE_ONLY_MESSAGE =
  'Esta la pide un especialista: solo se puede permitir una vez o denegar. «Siempre» y «Por ahora» no valen aquí.';

/** ¿La aprobación `id` de la lista pendiente es de las que solo admiten «una vez»? */
function isOnceOnly(pending: unknown, id: string): boolean {
  if (!Array.isArray(pending)) return false;
  return pending.some((item) => isRecord(item) && item.id === id && item.onceOnly === true);
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

type ApiRoute =
  | { method: 'GET'; kind: 'goals' }
  | { method: 'GET'; kind: 'routines' }
  | { method: 'GET'; kind: 'tareas' }
  | { method: 'GET'; kind: 'repartos' }
  | { method: 'GET'; kind: 'paginas' }
  | { method: 'GET'; kind: 'pagina'; id: string }
  | { method: 'GET'; kind: 'creado'; id: string }
  | { method: 'GET'; kind: 'funciones' }
  | { method: 'GET'; kind: 'contexto' }
  | { method: 'GET'; kind: 'mapaMemoria' }
  | { method: 'GET'; kind: 'status' }
  | { method: 'GET'; kind: 'sessions' }
  | { method: 'GET'; kind: 'memory' }
  | { method: 'GET'; kind: 'memoryScopes' }
  | { method: 'GET'; kind: 'audit' }
  | { method: 'GET'; kind: 'approvals' }
  | { method: 'POST'; kind: 'chat' }
  | { method: 'POST'; kind: 'chatRetry' }
  | { method: 'POST'; kind: 'modelo' }
  | { method: 'POST'; kind: 'clave' }
  | { method: 'POST'; kind: 'approval'; id: string };

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

/**
 * ¿El navegador acepta gzip? («gzip», «gzip;q=0.8», «*»; «gzip;q=0» no.)
 */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const raw = (Array.isArray(header) ? header.join(',') : (header ?? '')).toLowerCase();
  return raw.split(',').some((part) => {
    const [enc = '', ...params] = part.split(';').map((p) => p.trim());
    if (enc !== 'gzip' && enc !== '*') return false;
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** La página es la misma en cada petición: se comprime una sola vez y se guarda. */
let pageGzip: { src: string; gz: Buffer } | null = null;

/**
 * La página del panel (~120 KB) va comprimida si el navegador lo acepta (~30 KB):
 * carga antes desde el móvil por la red de casa o Tailscale, y la CPU solo comprime
 * la primera vez (después sale de la caché).
 */
function sendPage(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  contentType: string,
): void {
  res.setHeader('Vary', 'Accept-Encoding');
  if (!acceptsGzip(req.headers['accept-encoding'])) {
    send(res, 200, body, contentType);
    return;
  }
  if (pageGzip?.src !== body) pageGzip = { src: body, gz: gzipSync(body) };
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Content-Length', pageGzip.gz.length);
  res.end(pageGzip.gz);
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

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchApiRoute(pathname: string): ApiRoute | null {
  switch (pathname) {
    case '/api/goals':
      return { method: 'GET', kind: 'goals' };
    case '/api/routines':
      return { method: 'GET', kind: 'routines' };
    case '/api/tareas':
      return { method: 'GET', kind: 'tareas' };
    case '/api/repartos':
      return { method: 'GET', kind: 'repartos' };
    case '/api/paginas':
      return { method: 'GET', kind: 'paginas' };
    case '/api/funciones':
      return { method: 'GET', kind: 'funciones' };
    case '/api/contexto':
      return { method: 'GET', kind: 'contexto' };
    case '/api/mapa-memoria':
      return { method: 'GET', kind: 'mapaMemoria' };
    case '/api/status':
      return { method: 'GET', kind: 'status' };
    case '/api/sessions':
      return { method: 'GET', kind: 'sessions' };
    case '/api/memory':
      return { method: 'GET', kind: 'memory' };
    case '/api/memory/scopes':
      return { method: 'GET', kind: 'memoryScopes' };
    case '/api/audit/verify':
      return { method: 'GET', kind: 'audit' };
    case '/api/approvals':
      return { method: 'GET', kind: 'approvals' };
    case '/api/chat':
      return { method: 'POST', kind: 'chat' };
    case '/api/chat/retry':
      return { method: 'POST', kind: 'chatRetry' };
    case '/api/modelo':
      return { method: 'POST', kind: 'modelo' };
    case '/api/clave':
      return { method: 'POST', kind: 'clave' };
    default:
      break;
  }
  const creado = /^\/api\/creados\/([^/]+)$/.exec(pathname);
  if (creado?.[1]) {
    const id = safeDecode(creado[1]);
    return id ? { method: 'GET', kind: 'creado', id } : null;
  }
  const pagina = /^\/api\/paginas\/([^/]+)$/.exec(pathname);
  if (pagina?.[1]) {
    const id = safeDecode(pagina[1]);
    return id ? { method: 'GET', kind: 'pagina', id } : null;
  }
  const match = /^\/api\/approvals\/([^/]+)$/.exec(pathname);
  if (!match?.[1]) return null;
  const id = safeDecode(match[1]);
  if (!id) return null;
  return { method: 'POST', kind: 'approval', id };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Cuerpo demasiado grande');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
  if (!isRecord(parsed)) throw new HttpError(400, 'Se esperaba un objeto JSON');
  return parsed;
}

async function respondApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUiDeps,
  route: ApiRoute,
  url: URL,
): Promise<void> {
  let payload: unknown;
  try {
    const body = route.method === 'POST' ? await readJsonBody(req) : {};
    switch (route.kind) {
      case 'goals':
        if (!deps.goals) throw new HttpError(503, 'Objetivos no disponibles');
        payload = await deps.goals();
        if (payload === null) throw new HttpError(503, 'Objetivos aún no disponibles');
        break;
      case 'routines':
        payload = deps.routines ? await deps.routines() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Rutinas aún no disponibles');
        break;
      case 'tareas':
        payload = deps.tareas ? await deps.tareas() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Tareas aún no disponibles');
        break;
      case 'repartos':
        payload = deps.repartos ? await deps.repartos() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Paquetes aún no disponibles');
        break;
      case 'creado': {
        // Bytes tal cual, siempre como descarga (nunca se pinta en el panel).
        const f = deps.creado ? deps.creado(route.id) : null;
        if (!f) throw new HttpError(404, 'Archivo no encontrado');
        res.statusCode = 200;
        res.setHeader('Content-Type', f.mime);
        res.setHeader('Content-Length', f.bytes.length);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${f.nombre.replace(/[^A-Za-z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.nombre)}`,
        );
        res.setHeader('Cache-Control', 'no-store');
        res.end(f.bytes);
        return;
      }
      case 'paginas':
        payload = deps.paginas ? await deps.paginas() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Páginas aún no disponibles');
        break;
      case 'pagina':
        if (!deps.pagina) throw new HttpError(503, 'Páginas aún no disponibles');
        payload = await deps.pagina(route.id);
        if (payload === null || payload === undefined)
          throw new HttpError(404, 'Esa página ya no existe');
        break;
      case 'funciones':
        payload = panelFunciones();
        break;
      case 'contexto':
        payload = deps.contexto ? await deps.contexto() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Contexto aún no disponible');
        break;
      case 'mapaMemoria':
        payload = deps.mapaMemoria ? await deps.mapaMemoria(queryParam(url, 'scope')) : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Mapa de memoria aún no disponible');
        break;
      case 'status':
        payload = await deps.status();
        break;
      case 'sessions':
        payload = await deps.sessions(queryParam(url, 'q'));
        break;
      case 'memory':
        payload = await deps.memory(queryParam(url, 'scope'));
        break;
      case 'memoryScopes':
        if (!deps.memoryScopes) throw new HttpError(503, 'Ámbitos de memoria no disponibles');
        payload = await deps.memoryScopes();
        if (deps.memoryDefaultScope) {
          const porDefecto = deps.memoryDefaultScope();
          if (porDefecto) payload = { ambitos: payload, porDefecto };
        }
        break;
      case 'audit':
        payload = await deps.auditVerify();
        break;
      case 'approvals':
        if (!deps.approvals) throw new HttpError(503, 'Aprobaciones no disponibles');
        payload = await deps.approvals();
        break;
      case 'chat': {
        const text = body.text;
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw new HttpError(400, 'Falta el texto del mensaje');
        }
        if (!deps.chat) throw new HttpError(503, 'Chat no disponible');
        const answer = await deps.chat(text);
        if (!isRecord(answer) || typeof answer.text !== 'string') {
          throw new Error('deps.chat devolvio una respuesta invalida');
        }
        payload = panelReply(answer);
        break;
      }
      case 'chatRetry': {
        if (!deps.retry) throw new HttpError(503, 'Reintentar no disponible');
        const answer = await deps.retry();
        if (answer === null) throw new HttpError(409, 'No hay un mensaje reciente que repetir');
        if (answer === 'con-fotos') {
          throw new HttpError(
            409,
            'Tu último mensaje llevaba fotos y el panel no puede repetirlo. Mándamelo otra vez por Telegram, con las fotos.',
          );
        }
        if (!isRecord(answer) || typeof answer.text !== 'string')
          throw new Error('deps.retry devolvio una respuesta invalida');
        // Lo mismo que /api/chat: un turno repetido también trae sus capturas y archivos.
        payload = panelReply(answer);
        break;
      }
      case 'modelo': {
        const model = body.model;
        if (typeof model !== 'string' || model.trim().length === 0) {
          throw new HttpError(400, 'Falta el modelo');
        }
        if (!deps.setModelo) throw new HttpError(503, 'Cambio de modelo no disponible');
        const result = await deps.setModelo(model.trim());
        if (!isRecord(result) || typeof result.mensaje !== 'string') {
          throw new Error('deps.setModelo devolvió una respuesta inválida');
        }
        if (result.ok !== true) throw new HttpError(400, result.mensaje);
        payload = result;
        break;
      }
      case 'clave': {
        const clave = body.clave;
        if (typeof clave !== 'string' || clave.trim().length === 0) {
          throw new HttpError(400, 'Falta la clave');
        }
        if (!deps.setClave) throw new HttpError(503, 'Guardado de clave no disponible');
        const result = await deps.setClave(clave);
        if (!isRecord(result) || typeof result.mensaje !== 'string') {
          throw new Error('deps.setClave devolvió una respuesta inválida');
        }
        if (result.ok !== true) throw new HttpError(400, result.mensaje);
        // Nunca devolver la clave: solo el mensaje para el usuario.
        payload = { ok: true, mensaje: result.mensaje };
        break;
      }
      case 'approval': {
        const decision = body.decision;
        if (typeof decision !== 'string' || !DECISIONS.has(decision as ApprovalDecision)) {
          throw new HttpError(400, 'Decisión inválida');
        }
        if (!deps.approve) throw new HttpError(503, 'Aprobaciones no disponibles');
        // Lo que pide un especialista solo admite «una vez» o «denegar»: un «Siempre»
        // o «Por ahora» (un cliente viejo, una llamada a mano) no la resuelve, pero
        // tampoco es que ya no esté pendiente: se dice qué vale.
        if (
          (decision === 'always' || decision === 'session') &&
          deps.approvals &&
          isOnceOnly(await deps.approvals(), route.id)
        ) {
          throw new HttpError(409, ONCE_ONLY_MESSAGE);
        }
        const applied = await deps.approve(route.id, decision as ApprovalDecision);
        // Antes respondía { ok: true } aunque la aprobación no existiera o ya
        // hubiera caducado: el usuario creía haber decidido algo que no pasó.
        if (applied === false) throw new HttpError(404, 'La aprobación ya no está pendiente');
        payload = { ok: true };
        break;
      }
    }
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.message });
      return;
    }
    // El cliente recibe un 500 opaco; el detalle solo va al registro local.
    log.warn('webui: fallo una dependencia', {
      ruta: route.kind,
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
  allowedHosts: readonly string[] = [],
): Promise<void> {
  setBaseHeaders(res);
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const apiPath = pathname === '/api' || pathname.startsWith('/api/');

  if (!hostAllowed(req.headers.host, allowedHosts)) {
    res.setHeader('Cache-Control', 'no-store');
    if (apiPath) sendJson(res, 403, { error: 'Host no permitido' });
    else send(res, 403, 'Host no permitido', 'text/plain; charset=utf-8');
    return;
  }

  if (apiPath) {
    res.setHeader('Cache-Control', 'no-store');
    const route = matchApiRoute(pathname);
    if (!route) {
      sendJson(res, 404, { error: 'No encontrado' });
      return;
    }
    if (method !== route.method) {
      res.setHeader('Allow', route.method);
      sendJson(res, 405, { error: 'Método no permitido' });
      return;
    }
    if (!authorized(req, deps.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="asistenta"');
      sendJson(res, 401, { error: 'No autorizado' });
      return;
    }
    await respondApi(req, res, deps, route, url);
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
      sendPage(req, res, renderPage(), 'text/html; charset=utf-8');
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

/**
 * Nombres válidos en la cabecera Host. El panel solo escucha en loopback, pero
 * una web cualquiera puede apuntar su propio dominio a 127.0.0.1 (DNS rebinding)
 * y hacer que el navegador le hable al panel como si fuera ella. Rechazar los
 * Host ajenos corta eso de raíz; misma defensa que usa Kanvas en su servidor.
 */
const LOCAL_HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Nombre de la cabecera Host sin puerto, en minúsculas y sin punto final. */
export function hostHeaderName(header: string | undefined): string {
  const host = (header ?? '').trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? '' : host.slice(0, end + 1);
  }
  return host.replace(/:\d*$/, '').replace(/\.$/, '');
}

export function hostAllowed(header: string | undefined, extra: readonly string[] = []): boolean {
  const name = hostHeaderName(header);
  if (LOCAL_HOST_NAMES.has(name) || /^127(\.\d{1,3}){3}$/.test(name)) return true;
  return name !== '' && extra.some((h) => hostHeaderName(h) === name);
}

/**
 * Nombres extra que el dueño autoriza a mano (p. ej. el de Tailscale si sirve el
 * panel con `tailscale serve`). Lista separada por comas en PA_WEB_ALLOWED_HOSTS;
 * nunca comodines: cada nombre es exacto.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((h) => hostHeaderName(h))
    .filter((h) => h !== '' && !h.includes('*'));
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
  opts?: { port?: number; host?: string; allowedHosts?: readonly string[] },
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
  const allowedHosts = (opts?.allowedHosts ?? []).map((h) => hostHeaderName(h)).filter(Boolean);

  const server = createServer((req, res) => {
    void handleRequest(req, res, deps, allowedHosts).catch((error: unknown) => {
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

/** Respuesta de un turno del panel (chat o «Reintentar»): texto, capturas y archivos filtrados. */
function panelReply(answer: Record<string, unknown> & { text: string }): Record<string, unknown> {
  // Capturas del turno del panel (#arch8): solo data: de imagen, nada más.
  const images = Array.isArray(answer.images)
    ? answer.images.filter(
        (u): u is string => typeof u === 'string' && /^data:image\/(png|jpeg);base64,/.test(u),
      )
    : [];
  // Archivos del turno del panel (documentos, vídeo, voz): nombre sin rutas y
  // `data:` de una lista corta de tipos; nada más, máx. 4.
  const files = Array.isArray(answer.files)
    ? answer.files
        .filter(
          (f): f is { name: string; url: string } =>
            isRecord(f) &&
            typeof f.name === 'string' &&
            f.name.length > 0 &&
            f.name.length <= 120 &&
            // biome-ignore lint/suspicious/noControlCharactersInRegex: se rechazan a propósito nombres con caracteres de control
            !/[\\/\u0000-\u001f"<>]/.test(f.name) &&
            typeof f.url === 'string' &&
            PANEL_FILE_URL.test(f.url),
        )
        .slice(0, 4)
        .map((f) => ({ name: f.name, url: f.url }))
    : [];
  const out: Record<string, unknown> = { text: answer.text };
  if (images.length > 0) out.images = images;
  if (files.length > 0) out.files = files;
  // El turno falló por la red o el modelo caído: la página lo reintenta sola.
  if (answer.outage === true) out.outage = true;
  return out;
}
