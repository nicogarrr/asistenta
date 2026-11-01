/**
 * Conexión con la cuenta de Google del dueño (OAuth 2.0 para apps instaladas).
 *
 * Gratis y sin claves de terceros: el dueño crea una vez su propio cliente OAuth
 * («App de escritorio») en Google Cloud y Asistenta usa el flujo con PKCE (S256) y
 * redirección a 127.0.0.1 en un puerto libre (RFC 8252). El id/secreto del cliente y el
 * refresh token viven en la bóveda; el access token solo en memoria. Nada de esto se
 * escribe en el log ni sale a ningún sitio que no sea Google.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const GOOGLE_KEYS = {
  clientId: 'google:clientId',
  clientSecret: 'google:clientSecret',
  refreshToken: 'google:refreshToken',
  scopes: 'google:scopes',
} as const;

const CAL = 'https://www.googleapis.com/auth/calendar';
export const GOOGLE_SCOPES = {
  // Solo lectura: Asistenta no crea, mueve ni borra eventos.
  calendar: [`${CAL}.readonly`],
  gmailRead: ['https://www.googleapis.com/auth/gmail.readonly'],
} as const;
/** Lo mínimo que se usa hoy: leer tu calendario. */
export const DEFAULT_SCOPES: string[] = [...GOOGLE_SCOPES.calendar];

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Únicos hosts a los que habla este módulo (y sus clientes de Calendar y Gmail). */
export const GOOGLE_HOSTS = new Set([
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'gmail.googleapis.com',
]);

export const NOT_CONNECTED =
  'Tu cuenta de Google no está conectada. Se conecta una vez desde el PC: abre una terminal y escribe «pa google conectar» (los pasos están en docs/google.md).';

export class GoogleNotConnectedError extends Error {
  constructor(message = NOT_CONNECTED) {
    super(message);
    this.name = 'GoogleNotConnectedError';
  }
}

export interface GoogleVault {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<unknown>;
}

export interface GoogleDeps {
  vault: GoogleVault;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** fetch que se niega a salir de los hosts oficiales de Google. */
export function googleFetch(deps: Pick<GoogleDeps, 'fetch'>, url: string, init?: RequestInit) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !GOOGLE_HOSTS.has(u.hostname)) {
    throw new Error('Destino no permitido para Google.');
  }
  return (deps.fetch ?? fetch)(url, init);
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(o: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: 'code',
    scope: o.scopes.join(' '),
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${q}`;
}

/** Lee el JSON que Google deja descargar al crear el cliente («client_secret_….json»). */
export function parseClientJson(text: string): { clientId: string; clientSecret: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Ese fichero no es el JSON del cliente de Google.');
  }
  const d = data as Record<string, { client_id?: unknown; client_secret?: unknown }>;
  const c = d.installed ?? d.web;
  if (!c || typeof c.client_id !== 'string' || typeof c.client_secret !== 'string') {
    throw new Error('Ese fichero no es el JSON del cliente de Google.');
  }
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

async function tokenCall(deps: GoogleDeps, body: Record<string, string>) {
  const res = await googleFetch(deps, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {}
  return { status: res.status, json };
}

export interface LoopbackFlow {
  url: string;
  /** Resuelve con los permisos concedidos cuando el refresh token ya está en la bóveda. */
  done: Promise<{ scopes: string[] }>;
  close: () => void;
}

/**
 * Abre 127.0.0.1:<puerto libre>, devuelve el enlace de consentimiento y espera la vuelta
 * de Google. Comprueba `state`, cambia el código por tokens con el verificador PKCE y
 * guarda el refresh token. Caduca a los `timeoutMs` (5 min por defecto).
 */
export async function startLoopbackFlow(
  deps: GoogleDeps,
  opts: { scopes?: string[]; timeoutMs?: number } = {},
): Promise<LoopbackFlow> {
  const clientId = await deps.vault.get(GOOGLE_KEYS.clientId);
  const clientSecret = await deps.vault.get(GOOGLE_KEYS.clientSecret);
  if (!clientId || !clientSecret) {
    throw new GoogleNotConnectedError(
      'Falta el cliente de Google. Sigue los pasos de docs/google.md y ejecuta en el PC: pa google conectar <ruta del JSON>',
    );
  }
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  let finish!: (v: { scopes: string[] }) => void;
  let fail!: (e: Error) => void;
  const done = new Promise<{ scopes: string[] }>((res, rej) => {
    finish = res;
    fail = rej;
  });
  done.catch(() => {});
  let redirectUri = '';
  const server = createServer((req, res) => {
    let u: URL;
    try {
      u = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      // Una línea de petición malformada no debe tumbar la conexión en curso.
      res.writeHead(400).end();
      return;
    }
    if (u.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const reply = (ok: boolean, text: string) => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><p style="font:18px sans-serif">${text}</p>`);
    };
    if (u.searchParams.get('state') !== state) {
      reply(false, 'Enlace no válido. Vuelve a escribir «pa google conectar» en el PC.');
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) {
      reply(false, 'No se ha dado permiso. Puedes cerrar esta pestaña.');
      close();
      fail(new Error('No se ha dado permiso a Google.'));
      return;
    }
    tokenCall(deps, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    })
      .then(async ({ status, json }) => {
        const refresh = json.refresh_token;
        if (status !== 200 || typeof refresh !== 'string')
          throw new Error('Google no ha dado acceso.');
        const granted = typeof json.scope === 'string' ? json.scope.split(' ') : scopes;
        await deps.vault.set(GOOGLE_KEYS.refreshToken, refresh);
        await deps.vault.set(GOOGLE_KEYS.scopes, granted.join(' '));
        reply(true, 'Listo, Google conectado. Ya puedes cerrar esta pestaña.');
        finish({ scopes: granted });
      })
      .catch((err: Error) => {
        reply(false, 'No se ha podido conectar con Google. Inténtalo otra vez.');
        fail(err);
      })
      .finally(close);
  });
  const timer = setTimeout(() => {
    close();
    fail(new Error('Ha caducado el enlace de Google (5 min). Pide otro.'));
  }, opts.timeoutMs ?? 300_000);
  timer.unref?.();
  function close() {
    clearTimeout(timer);
    server.close();
  }
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = buildAuthUrl({ clientId, redirectUri, scopes, state, challenge });
  return { url, done, close };
}

const transient = (status: number) => status === 429 || status >= 500;

/** Access tokens en memoria, renovados con el refresh token de la bóveda. */
export class GoogleAuth {
  #cache?: { token: string; until: number };
  private deps: GoogleDeps;
  constructor(deps: GoogleDeps) {
    this.deps = deps;
  }

  async connected(): Promise<boolean> {
    return Boolean(await this.deps.vault.get(GOOGLE_KEYS.refreshToken));
  }

  async scopes(): Promise<string[]> {
    return ((await this.deps.vault.get(GOOGLE_KEYS.scopes)) ?? '').split(' ').filter(Boolean);
  }

  async accessToken(): Promise<string> {
    const now = this.deps.now ?? Date.now;
    if (this.#cache && this.#cache.until > now()) return this.#cache.token;
    const refresh = await this.deps.vault.get(GOOGLE_KEYS.refreshToken);
    const clientId = await this.deps.vault.get(GOOGLE_KEYS.clientId);
    const clientSecret = await this.deps.vault.get(GOOGLE_KEYS.clientSecret);
    if (!refresh || !clientId || !clientSecret) throw new GoogleNotConnectedError();
    const sleep = this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let last = 'Google no responde ahora mismo. Prueba en un rato.';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(1000 * 2 ** (attempt - 1));
      let r: Awaited<ReturnType<typeof tokenCall>>;
      try {
        r = await tokenCall(this.deps, {
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refresh,
          grant_type: 'refresh_token',
        });
      } catch {
        last = 'No llego a Google (¿sin conexión?). Prueba en un rato.';
        continue;
      }
      const token = r.json.access_token;
      if (r.status === 200 && typeof token === 'string') {
        const secs = typeof r.json.expires_in === 'number' ? r.json.expires_in : 3600;
        this.#cache = { token, until: now() + Math.max(0, secs - 60) * 1000 };
        return token;
      }
      if (transient(r.status)) continue;
      if (r.json.error === 'invalid_grant') {
        // Revocado desde la cuenta de Google o caducado: hay que volver a conectar.
        await this.deps.vault.delete(GOOGLE_KEYS.refreshToken);
        throw new GoogleNotConnectedError(
          'Google ha retirado el permiso. Para volver a conectarlo, escribe «pa google conectar» en una terminal del PC.',
        );
      }
      throw new Error('Google ha rechazado la conexión. Revisa el cliente en docs/google.md.');
    }
    throw new Error(last);
  }

  /** Revoca en Google (si se puede) y borra el refresh token. El cliente se queda. */
  async disconnect(): Promise<boolean> {
    const refresh = await this.deps.vault.get(GOOGLE_KEYS.refreshToken);
    this.#cache = undefined;
    if (!refresh) return false;
    try {
      await googleFetch(this.deps, REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refresh }).toString(),
      });
    } catch {}
    await this.deps.vault.delete(GOOGLE_KEYS.refreshToken);
    await this.deps.vault.delete(GOOGLE_KEYS.scopes);
    return true;
  }
}
