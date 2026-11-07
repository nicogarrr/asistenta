import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { log } from '../log.js';
import { createServer } from '../node-http.js';
import { panelFunciones } from './funciones-view.js';
import { renderManifest, renderPage, renderServiceWorker } from './page.js';
import { renderVozPage } from './voz-page.js';
import { tomarResto } from './voz-rapida.js';
import {
  type EventoVoz,
  type FraseVoz,
  PERDONA_PENSAR,
  turnoVoz,
  type VozTurnoDeps,
} from './voz-turno.js';

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
  /** Tarjeta «Apuntes»: temas de apuntes con sus archivos (expertos/panel.ts). Si falta, 503. */
  expertos?(): unknown | Promise<unknown>;
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
  /** Tarjeta Funciones → «Lo que más usas» (uso-funciones.ts usoPanel). Si falta, 503. */
  uso?(): unknown | Promise<unknown>;
  /** Chat libre desde el panel. Si falta, la ruta responde 503. */
  chat?(
    text: string,
    /** Desde /voz: respuesta corta para decirla y el texto según se escribe (`onDelta`). */
    opts?: { voz?: boolean; onDelta?: (delta: string) => void },
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
  /**
   * Mini App de Telegram (miniapp.ts): ¿este `initData` está firmado por el bot y es del
   * dueño? Si dice que sí, /api/miniapp devuelve el token del panel. Si falta, 503.
   */
  miniApp?(initData: string): boolean | Promise<boolean>;
  /**
   * /voz desde el móvil: transcribe la nota (whisper local). La respuesta sale de `chat`,
   * el mismo hilo que el chat del panel. Si falta, /api/voz responde 503.
   */
  transcribe?(audio: Buffer, mime: string): Promise<string>;
  /**
   * /voz: la respuesta en audio hecha en el PC con la voz local (sherpa-onnx, la misma
   * de las notas de voz de Telegram). Si falta, falla o devuelve null, el móvil la lee
   * con su propia voz.
   */
  speak?(text: string): Promise<{ data: Buffer; mimeType: string } | null>;
  /** Al abrir /voz: carga whisper y la voz en segundo plano para que la primera nota no espere. */
  prewarm?(): void;
}

const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
/** Una nota de /voz: un minuto de opus/aac son ~0,5 MB; 8 MB deja margen sin abrir la puerta. */
const MAX_VOICE_BYTES = 8 * 1024 * 1024;

async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'La nota es demasiado larga (máximo unos minutos)');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
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
  // /voz reproduce la voz del PC desde un blob (y un silencio en data: para iOS).
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Orígenes de Telegram que pueden enmarcar el panel como Mini App: Telegram Web
 * (web.telegram.org, sus versiones /k y /a) la mete en un iframe. En el iPhone y en
 * Telegram Desktop la Mini App es una vista propia, sin iframe, y no necesita esto.
 */
export const TELEGRAM_FRAME_ANCESTORS = ['https://web.telegram.org', 'https://*.telegram.org'];

/**
 * ¿Esta petición de página es Telegram Web abriendo la Mini App? Solo si el navegador
 * dice que la carga es para un marco (`Sec-Fetch-Dest: iframe`) y quien la pide es
 * una página https de telegram.org (o no dice quién). Cualquier otro caso (navegación
 * normal, otro origen, navegador que no manda Sec-Fetch-Dest) sigue con DENY. Aunque alguien
 * falsificara las cabeceras, `frame-ancestors` deja que solo telegram.org enmarque.
 */
export function isTelegramFrame(headers: IncomingMessage['headers']): boolean {
  const dest = String(headers['sec-fetch-dest'] ?? '').toLowerCase();
  if (dest !== 'iframe' && dest !== 'frame') return false;
  const from = String(headers.origin ?? headers.referer ?? '');
  // Sin Referer (política no-referrer) se acepta igual: quien enmarca lo decide el
  // navegador con frame-ancestors, que solo deja a telegram.org.
  if (from === '') return true;
  let host: string;
  try {
    const u = new URL(from);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'telegram.org' || host.endsWith('.telegram.org');
}

/** CSP de las páginas: igual que siempre, salvo `frame-ancestors` para Telegram Web. */
export function pageCsp(telegramFrame: boolean): string {
  if (!telegramFrame) return PAGE_CSP;
  return PAGE_CSP.replace(
    "frame-ancestors 'none'",
    `frame-ancestors ${TELEGRAM_FRAME_ANCESTORS.join(' ')}`,
  );
}

function setPageFrameHeaders(req: IncomingMessage, res: ServerResponse): void {
  const telegram = isTelegramFrame(req.headers);
  res.setHeader('Content-Security-Policy', pageCsp(telegram));
  // X-Frame-Options no admite listas: con Telegram se quita y manda frame-ancestors.
  if (telegram) res.removeHeader('X-Frame-Options');
}

type ApiRoute =
  | { method: 'GET'; kind: 'goals' }
  | { method: 'GET'; kind: 'routines' }
  | { method: 'GET'; kind: 'tareas' }
  | { method: 'GET'; kind: 'repartos' }
  | { method: 'GET'; kind: 'paginas' }
  | { method: 'GET'; kind: 'pagina'; id: string }
  | { method: 'GET'; kind: 'creado'; id: string }
  | { method: 'GET'; kind: 'expertos' }
  | { method: 'GET'; kind: 'funciones' }
  | { method: 'GET'; kind: 'uso' }
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
  | { method: 'POST'; kind: 'miniapp' }
  | { method: 'POST'; kind: 'voz' }
  | { method: 'GET'; kind: 'vozResto' }
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
    case '/api/expertos':
      return { method: 'GET', kind: 'expertos' };
    case '/api/funciones':
      return { method: 'GET', kind: 'funciones' };
    case '/api/uso':
      return { method: 'GET', kind: 'uso' };
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
    case '/api/miniapp':
      return { method: 'POST', kind: 'miniapp' };
    case '/api/voz':
      return { method: 'POST', kind: 'voz' };
    case '/api/voz/resto':
      return { method: 'GET', kind: 'vozResto' };
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
    const body = route.method === 'POST' && route.kind !== 'voz' ? await readJsonBody(req) : {};
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
      case 'expertos':
        payload = deps.expertos ? await deps.expertos() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Apuntes aún no disponibles');
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
      case 'uso':
        payload = deps.uso ? await deps.uso() : null;
        if (payload === null || payload === undefined)
          throw new HttpError(503, 'Uso aún no disponible');
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
        // Cuánto tarda cada turno del panel: un «Pensando…» de 2 min se ve en el log.
        const tChat = Date.now();
        let answer: Awaited<ReturnType<NonNullable<WebUiDeps['chat']>>>;
        try {
          answer = await deps.chat(text);
        } catch (error) {
          log.warn('panel chat: falló', { ms: Date.now() - tChat });
          throw error;
        }
        log.info('panel chat: tiempos', { ms: Date.now() - tChat });
        if (!isRecord(answer) || typeof answer.text !== 'string') {
          throw new Error('deps.chat devolvio una respuesta invalida');
        }
        payload = panelReply(answer);
        break;
      }
      case 'vozResto': {
        const audio = await tomarResto(url.searchParams.get('id') ?? '');
        if (!audio) throw new HttpError(404, 'Ese audio ya no está');
        payload = audio;
        break;
      }
      case 'voz': {
        if (!deps.transcribe || !deps.chat) throw new HttpError(503, 'La voz no está disponible');
        const mime = String(req.headers['content-type'] ?? '')
          .split(';')[0]
          ?.trim()
          .toLowerCase();
        if (!mime?.startsWith('audio/')) throw new HttpError(415, 'Eso no es audio');
        const inicio = Date.now();
        const audio = await readRawBody(req, MAX_VOICE_BYTES);
        if (audio.length === 0) throw new HttpError(400, 'No ha llegado audio');
        const medidas = { inicio, recibirMs: Date.now() - inicio };
        const chat = deps.chat;
        const vozDeps: VozTurnoDeps = {
          transcribe: deps.transcribe,
          chat: (t, o) => chat(t, o),
          ...(deps.speak ? { speak: deps.speak } : {}),
        };
        // Modo flujo (la página /voz): una línea JSON por evento, cada frase con su voz
        // en cuanto está, para que el móvil empiece a hablar mientras el PC piensa.
        if (String(req.headers.accept ?? '').includes('application/x-ndjson')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.flushHeaders?.();
          const emit = (e: EventoVoz): void => {
            if (res.writableEnded) return;
            const linea =
              e.tipo === 'fin'
                ? (() => {
                    const { respuesta, ...resto } = e;
                    return { ...resto, ...(respuesta ? panelReply(respuesta) : {}), text: e.text };
                  })()
                : e;
            res.write(`${JSON.stringify(linea)}\n`);
          };
          try {
            await turnoVoz(audio, mime, vozDeps, emit, medidas, 'flujo');
          } catch (err) {
            log.warn('voz movil: el turno se cortó', { err: describeError(err) });
            emit({
              tipo: 'fin',
              oido: '',
              text: PERDONA_PENSAR,
              fallo: 'pensar',
              tiempos: {
                ...medidas,
                oirMs: 0,
                pensarMs: 0,
                primeraVozMs: 0,
                vozMs: 0,
                totalMs: Date.now() - inicio,
                rapida: false,
              },
            });
          }
          res.end();
          return;
        }
        // JSON de siempre: la primera frase con su audio y el resto en /api/voz/resto.
        let primera: FraseVoz | undefined;
        let fin: Extract<EventoVoz, { tipo: 'fin' }> | undefined;
        await turnoVoz(
          audio,
          mime,
          vozDeps,
          (e) => {
            if (e.tipo === 'frase' && !primera) primera = e;
            if (e.tipo === 'fin') fin = e;
          },
          medidas,
          'json',
        );
        if (!fin) throw new Error('el turno de voz no terminó');
        const respuesta: Record<string, unknown> = {
          oido: fin.oido,
          ...(fin.respuesta ? panelReply(fin.respuesta) : {}),
          text: fin.text,
        };
        if (fin.respuesta && typeof fin.respuesta.audioResto === 'string') {
          respuesta.audioResto = fin.respuesta.audioResto;
        }
        if (primera?.audio) respuesta.audio = primera.audio;
        if (fin.fallo) respuesta.fallo = fin.fallo;
        if (fin.pendiente) respuesta.pendiente = fin.pendiente;
        respuesta.tiempos = fin.tiempos;
        payload = respuesta;
        break;
      }
      case 'miniapp': {
        if (!deps.miniApp) throw new HttpError(503, 'La Mini App no está disponible');
        const initData = body.initData;
        if (typeof initData !== 'string' || !(await deps.miniApp(initData))) {
          throw new HttpError(
            401,
            'Telegram no ha confirmado que seas tú. Ábrelo desde tu chat con el bot.',
          );
        }
        payload = { token: deps.token };
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
    // /api/miniapp es la puerta para entrar SIN token: su prueba es la firma de Telegram.
    if (route.kind !== 'miniapp' && !authorized(req, deps.token)) {
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
      setPageFrameHeaders(req, res);
      res.setHeader('Cache-Control', 'no-store');
      sendPage(req, res, renderPage(), 'text/html; charset=utf-8');
      return;
    case '/voz':
      setPageFrameHeaders(req, res);
      res.setHeader('Cache-Control', 'no-store');
      // Mientras Nico pulsa «Hablar», el PC ya carga whisper y la voz.
      try {
        deps.prewarm?.();
      } catch {
        // Calentar es opcional: nunca rompe la página.
      }
      sendPage(req, res, renderVozPage(), 'text/html; charset=utf-8');
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

/**
 * PA_PANEL_PUBLIC_URL: la dirección https con la que se abre el panel desde fuera
 * (p. ej. `https://tu-pc.tu-red.ts.net/` de `tailscale serve`). Devuelve la URL
 * normalizada con barra final, o '' si falta o no es https (Telegram solo abre Mini
 * Apps por https). Sin usuario ni contraseña en la URL.
 */
export function parsePanelPublicUrl(raw: string | undefined): string {
  const text = (raw ?? '').trim();
  if (text === '') return '';
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.hostname.includes('*')) return '';
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

/**
 * Nombres que el panel acepta en Host: los de PA_WEB_ALLOWED_HOSTS más el de
 * PA_PANEL_PUBLIC_URL, para que configurar la dirección pública baste.
 */
export function panelAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = parseAllowedHosts(env.PA_WEB_ALLOWED_HOSTS);
  const pub = parsePanelPublicUrl(env.PA_PANEL_PUBLIC_URL);
  if (pub) {
    const name = hostHeaderName(new URL(pub).host);
    if (name && !hosts.includes(name)) hosts.push(name);
  }
  return hosts;
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
