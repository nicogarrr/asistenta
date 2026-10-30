/**
 * F3 — webhook entrante para lanzar una rutina desde fuera (IFTTT local, un
 * script, Home Assistant en la misma máquina…).
 *
 * Apagado por defecto: solo arranca con PA_WEBHOOK_PORT y un PA_WEBHOOK_TOKEN de
 * al menos 24 caracteres. Escucha SOLO en 127.0.0.1, exige
 * `Authorization: Bearer <token>` (comparación en tiempo constante), limita
 * peticiones por minuto (también las fallidas) y comprueba la cabecera Host
 * contra DNS rebinding. El cuerpo se ignora: la rutina corre con su propio
 * prompt, nunca con texto de fuera, y con sus permisos y aprobaciones de siempre.
 *
 *   curl -X POST -H "Authorization: Bearer $PA_WEBHOOK_TOKEN" http://127.0.0.1:8787/hook/resumen
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const WEBHOOK_HOST = '127.0.0.1';
export const WEBHOOK_MIN_TOKEN = 24;
export const WEBHOOK_MAX_BODY = 8 * 1024;

export interface WebhookConfig {
  port: number;
  token: string;
  /** Si no está vacío, solo estas rutinas se pueden lanzar. */
  allow: string[];
  perMinute: number;
}

/** null = apagado; { error } = mal configurado (no arranca). */
export function webhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): WebhookConfig | { error: string } | null {
  const rawPort = (env.PA_WEBHOOK_PORT ?? '').trim();
  if (!rawPort || rawPort.toLowerCase() === 'off') return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `PA_WEBHOOK_PORT no es un puerto válido: ${rawPort}` };
  }
  const token = (env.PA_WEBHOOK_TOKEN ?? '').trim();
  if (token.length < WEBHOOK_MIN_TOKEN) {
    return { error: `PA_WEBHOOK_TOKEN tiene que tener al menos ${WEBHOOK_MIN_TOKEN} caracteres` };
  }
  const allow = (env.PA_WEBHOOK_ROUTINES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const per = Number(env.PA_WEBHOOK_PER_MINUTE ?? 10);
  const perMinute = Number.isFinite(per) && per >= 1 ? Math.floor(per) : 10;
  return { port, token, allow, perMinute };
}

export interface WebhookResult {
  status: number;
  message: string;
}

export interface WebhookServerOptions extends WebhookConfig {
  trigger: (name: string) => Promise<WebhookResult>;
  now?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Comparación en tiempo constante (también si las longitudes difieren). */
export function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Ventana deslizante de un minuto, global. */
export class RateLimiter {
  readonly #hits: number[] = [];
  readonly perMinute: number;
  readonly now: () => number;
  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  take(): boolean {
    const t = this.now();
    while (this.#hits.length && t - (this.#hits[0] ?? 0) >= 60_000) this.#hits.shift();
    if (this.#hits.length >= this.perMinute) return false;
    this.#hits.push(t);
    return true;
  }
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: status < 300, message }));
}

function hostOk(req: IncomingMessage, port: number): boolean {
  const host = (req.headers.host ?? '').toLowerCase();
  return host === `${WEBHOOK_HOST}:${port}` || host === `localhost:${port}`;
}

async function drain(req: IncomingMessage): Promise<boolean> {
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > WEBHOOK_MAX_BODY) return false;
  }
  return true;
}

export async function startWebhookServer(
  opts: WebhookServerOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  const limiter = new RateLimiter(opts.perMinute, opts.now);
  let boundPort = opts.port;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        // El límite va antes que el token: también frena a quien prueba tokens.
        if (!limiter.take()) return reply(res, 429, 'demasiadas peticiones; espera un minuto');
        if (!hostOk(req, boundPort)) return reply(res, 403, 'host no permitido');
        if (req.method !== 'POST') return reply(res, 405, 'solo POST');
        const auth = String(req.headers.authorization ?? '');
        const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        if (!given || !tokenMatches(given, opts.token)) {
          opts.log?.('webhook: token incorrecto');
          return reply(res, 401, 'token incorrecto');
        }
        const m = /^\/hook\/([^/?#]{1,64})(?:\?.*)?$/.exec(req.url ?? '');
        if (!m?.[1]) return reply(res, 404, 'usa POST /hook/<rutina>');
        let name: string;
        try {
          name = decodeURIComponent(m[1]).trim();
        } catch {
          return reply(res, 400, 'nombre de rutina mal codificado');
        }
        if (!(await drain(req))) return reply(res, 413, 'cuerpo demasiado grande');
        if (opts.allow.length && !opts.allow.includes(name)) {
          return reply(res, 403, `la rutina "${name}" no está en PA_WEBHOOK_ROUTINES`);
        }
        const r = await opts.trigger(name);
        opts.log?.('webhook: disparo', { name, status: r.status });
        return reply(res, r.status, r.message);
      } catch (err) {
        opts.log?.('webhook: error', { err: String(err) });
        if (!res.headersSent) reply(res, 500, 'error interno');
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, WEBHOOK_HOST, () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') boundPort = addr.port;
  return {
    port: boundPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
