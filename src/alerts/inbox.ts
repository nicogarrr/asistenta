/**
 * Canal de entrada de alertas (CavaAI -> Asistenta): `POST /alerts/ingest`.
 *
 * Una alerta es DATO, no una orden. Lo que llega aqui se valida, se limpia y se
 * reenvia como texto plano al chat privado del dueno. Nunca pasa por el agente,
 * ni por el modelo, ni por ninguna tool: un cuerpo hostil no puede inyectar
 * instrucciones porque no hay nada que las interprete.
 *
 * Red: bind a loopback por defecto. Para que CavaAI (Oracle VM) llegue sin abrir
 * el PC a internet, hay dos caminos documentados en docs/alerts-inbox.md: IP de
 * tailscale (rango 100.64/10, aceptado) o tunel SSH inverso iniciado desde el PC.
 * Aunque se haga bind a 0.0.0.0, se rechaza todo origen que no sea privado.
 *
 * Auth: HMAC-SHA256 con secreto del vault (`alerts:token`) sobre
 * `ts.nonce.POST./alerts/ingest.sha256(cuerpo)`. El secreto no viaja, la firma
 * cubre el cuerpo (no se puede cambiar el texto de una alerta firmada), caduca a
 * +-5 min y una firma vista no se acepta dos veces. Sin token el listener NO
 * arranca (fail-closed, al contrario que el del boton del mando).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { writeFileReplacing } from '../fs-tmp.js';
import { log } from '../log.js';
import { isPrivateRemote } from '../tv/button-listener.js';

export const ALERT_INBOX_PORT = 8766;
export const ALERT_INGEST_PATH = '/alerts/ingest';
export const ALERT_HEALTH_PATH = '/alerts/health';
export const ALERT_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
export const ALERT_MAX_BODY_BYTES = 4096;
const DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEDUPE_MAX = 1000;
const RATE_LIMIT_PER_MINUTE = 30;

export type AlertSeverity = 'info' | 'warn' | 'critical';

export interface Alert {
  id: string;
  source: string;
  severity: AlertSeverity;
  title: string;
  text?: string;
  url?: string;
}

/** Mensaje canonico firmado. Exportado para que el cliente firme lo mismo que se verifica. */
export function alertMessage(ts: string, nonce: string, body: string): string {
  const digest = createHash('sha256').update(body).digest('hex');
  return `${ts}.${nonce}.POST.${ALERT_INGEST_PATH}.${digest}`;
}

export function signAlert(secret: string, ts: string, nonce: string, body: string): string {
  return createHmac('sha256', secret)
    .update(alertMessage(ts, nonce, body))
    .digest('hex');
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: se eliminan a proposito
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

function clean(value: string): string {
  return value
    .replace(CONTROL, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Valida la forma y limpia el texto. Devuelve el motivo del rechazo, no lanza. */
export function parseAlert(
  raw: unknown,
  allowedSources: readonly string[],
): { ok: true; alert: Alert } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'cuerpo' };
  const o = raw as Record<string, unknown>;
  const str = (k: string, max: number): string | null =>
    typeof o[k] === 'string' && (o[k] as string).length <= max ? clean(o[k] as string) : null;
  const id = str('id', 100);
  if (!id || !/^[\w.:-]{1,100}$/.test(id)) return { ok: false, error: 'id' };
  const source = (str('source', 40) ?? 'cavaai').toLowerCase();
  if (!allowedSources.includes(source)) return { ok: false, error: 'source' };
  const severity = o.severity ?? 'info';
  if (severity !== 'info' && severity !== 'warn' && severity !== 'critical')
    return { ok: false, error: 'severity' };
  const title = str('title', 120);
  if (!title) return { ok: false, error: 'title' };
  const alert: Alert = { id, source, severity, title };
  if (o.text !== undefined) {
    const text = str('text', 800);
    if (text === null) return { ok: false, error: 'text' };
    if (text) alert.text = text;
  }
  if (o.url !== undefined) {
    const url = str('url', 300);
    if (url === null || !/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, error: 'url' };
    alert.url = url;
  }
  return { ok: true, alert };
}

const ICON: Record<AlertSeverity, string> = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };

/** Texto plano para Telegram: sin markdown ni formato que un emisor pueda abusar. */
export function formatAlert(alert: Alert): string {
  const head = `${ICON[alert.severity]} ${alert.source} [${alert.severity}] ${alert.title}`;
  return [head, alert.text, alert.url].filter(Boolean).join('\n');
}

export interface AlertInboxOptions {
  port?: number;
  /** Por defecto loopback. */
  host?: string;
  /** Secreto del vault. Sin el, el listener no arranca. */
  token: string | null | undefined;
  /** Fuentes aceptadas. Por defecto solo cavaai. */
  sources?: readonly string[];
  /** Entrega al dueno. false = no hay chat del dueno todavia: el emisor reintenta. */
  send: (text: string) => Promise<boolean>;
  now?: () => number;
  /**
   * Fichero donde se recuerdan las alertas ya entregadas (24 h). Sin él, la memoria
   * vive solo en el proceso: un reintento del emisor tras reiniciar el daemon se
   * entregaba dos veces.
   */
  dedupeFile?: string;
}

/** Clave de deduplicado: el mismo id en dos fuentes son dos alertas distintas. */
export function alertKey(alert: Pick<Alert, 'source' | 'id'>): string {
  return `${alert.source}:${alert.id}`;
}

function loadSeen(file: string | undefined, t: number): Map<string, number> {
  const seen = new Map<string, number>();
  if (!file) return seen;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      for (const [key, exp] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof exp === 'number' && Number.isFinite(exp) && exp > t) seen.set(key, exp);
      }
    }
  } catch {
    // Sin fichero o corrupto: se empieza de cero (como antes del cambio).
  }
  return seen;
}

export function saveSeen(file: string | undefined, seen: Map<string, number>): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileReplacing(file, JSON.stringify(Object.fromEntries(seen)));
  } catch (err) {
    log.warn('alert inbox: no se pudo guardar el deduplicado', { err });
  }
}

export interface AlertInbox {
  server: Server;
  readonly port: number;
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function startAlertInbox(opts: AlertInboxOptions): AlertInbox | null {
  const token = opts.token?.trim();
  if (!token) return null;
  const now = opts.now ?? Date.now;
  const sources = (opts.sources ?? ['cavaai']).map((s) => s.toLowerCase());
  const port = opts.port ?? ALERT_INBOX_PORT;
  const host = opts.host ?? '127.0.0.1';
  const seenSignatures = new Map<string, number>();
  const seenIds = loadSeen(opts.dedupeFile, now());
  const inFlight = new Set<string>();
  // Sliding window: when each accepted alert of the last minute went out. A fixed
  // window reset every 60 s let 30 through at 0:59 and 30 more at 1:00.
  const sentAt: number[] = [];

  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  const readBody = (req: IncomingMessage): Promise<string | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > ALERT_MAX_BODY_BYTES) {
          over = true;
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', () => resolve(null));
    });

  const signatureOk = (req: IncomingMessage, body: string): boolean => {
    const ts = req.headers['x-alert-ts'];
    const nonce = req.headers['x-alert-nonce'];
    const sig = req.headers['x-alert-sig'];
    if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string')
      return false;
    if (!/^\d{9,13}$/.test(ts) || !/^[0-9a-f]{8,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig))
      return false;
    const tsMs = Number(ts) * 1000;
    const t = now();
    if (Math.abs(t - tsMs) > ALERT_SIGNATURE_WINDOW_MS) return false;
    const expected = Buffer.from(signAlert(token, ts, nonce, body));
    const got = Buffer.from(sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
    for (const [s, exp] of seenSignatures) if (t > exp) seenSignatures.delete(s);
    if (seenSignatures.has(sig)) return false;
    seenSignatures.set(sig, tsMs + ALERT_SIGNATURE_WINDOW_MS);
    return true;
  };

  const server = createServer((req, res) => {
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (!isPrivateRemote(remote)) {
      log.warn('alert inbox: origen no permitido', { remote });
      reply(res, 403, { ok: false, error: 'origen no permitido' });
      return;
    }
    const path = req.url?.split('?')[0]?.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    if (path === ALERT_HEALTH_PATH && (method === 'GET' || method === 'HEAD')) {
      reply(res, 200, { ok: true, service: 'alert-inbox' });
      return;
    }
    if (path !== ALERT_INGEST_PATH) {
      reply(res, 404, { ok: false, error: 'no encontrado' });
      return;
    }
    if (method !== 'POST') {
      reply(res, 405, { ok: false, error: 'metodo no permitido' });
      return;
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > ALERT_MAX_BODY_BYTES) {
      reply(res, 413, { ok: false, error: 'cuerpo demasiado grande' });
      return;
    }
    void (async () => {
      const body = await readBody(req);
      if (body === null) {
        reply(res, 413, { ok: false, error: 'cuerpo demasiado grande' });
        return;
      }
      // La firma va primero: un no autenticado no aprende nada sobre el esquema.
      if (!signatureOk(req, body)) {
        log.warn('alert inbox: firma no valida', { remote });
        reply(res, 401, { ok: false, error: 'no autorizado' });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        reply(res, 400, { ok: false, error: 'json' });
        return;
      }
      const result = parseAlert(parsed, sources);
      if (!result.ok) {
        reply(res, 400, { ok: false, error: result.error });
        return;
      }
      const { alert } = result;
      const t = now();
      // Si no se llega a entregar, la misma petición firmada tiene que poder repetirse:
      // la respuesta dice «reintenta», y antes ese reintento idéntico era un replay (401)
      // y la alerta se perdía. Reenviar algo que no se entregó no es un replay dañino.
      const releaseSignature = (): void => {
        const sig = req.headers['x-alert-sig'];
        if (typeof sig === 'string') seenSignatures.delete(sig);
      };
      const key = alertKey(alert);
      for (const [k, exp] of seenIds) if (t > exp) seenIds.delete(k);
      if (seenIds.has(key) || inFlight.has(key)) {
        reply(res, 200, { ok: true, duplicate: true });
        return;
      }
      while (sentAt.length > 0 && t - (sentAt[0] ?? t) >= 60_000) sentAt.shift();
      if (sentAt.length >= RATE_LIMIT_PER_MINUTE) {
        reply(res, 429, { ok: false, error: 'demasiadas alertas' });
        return;
      }
      sentAt.push(t);
      inFlight.add(key);
      try {
        const delivered = await opts.send(formatAlert(alert));
        if (!delivered) {
          // Nada salió hacia Telegram: ni gasta cupo ni quema la firma. Sin esto, un
          // emisor reintentando mientras aún no hay chat del dueño agotaba el cupo del
          // minuto y la primera alerta real tras abrir el chat recibía 429.
          const slot = sentAt.lastIndexOf(t);
          if (slot >= 0) sentAt.splice(slot, 1);
          releaseSignature();
          reply(res, 503, { ok: false, error: 'sin chat del dueno; reintenta' });
          return;
        }
        seenIds.set(key, t + DEDUPE_TTL_MS);
        if (seenIds.size > DEDUPE_MAX) {
          const oldest = seenIds.keys().next().value;
          if (oldest !== undefined) seenIds.delete(oldest);
        }
        saveSeen(opts.dedupeFile, seenIds);
        log.info('alert delivered', {
          id: alert.id,
          source: alert.source,
          severity: alert.severity,
        });
        reply(res, 202, { ok: true });
      } catch (err) {
        log.warn('alert inbox: fallo de entrega', { err });
        // El envío pudo salir a medias: el cupo se queda gastado, pero la firma se libera
        // para que el reintento que pide la respuesta no se trate como replay.
        releaseSignature();
        reply(res, 503, { ok: false, error: 'entrega fallida; reintenta' });
      } finally {
        inFlight.delete(key);
      }
    })();
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  void ready.catch(() => undefined);
  server.listen(port, host);

  return {
    server,
    get port(): number {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : port;
    },
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
