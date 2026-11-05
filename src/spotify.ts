/**
 * Spotify por su API oficial (Web API) con PKCE: sin secreto, solo el Client ID de la
 * «app» gratis que el dueño crea en developer.spotify.com (PA_SPOTIFY_CLIENT_ID en .env).
 * El refresh token vive en la bóveda; el access token solo en memoria. Controlar la
 * reproducción exige Spotify Premium: sin Premium, Spotify responde 403 y se dice así.
 * Pasos para el dueño: docs/SETUP-INTEGRACIONES.md, apartado Spotify.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from './node-http.js';

export const SPOTIFY_KEYS = { refreshToken: 'spotify:refreshToken' } as const;
export const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API = 'https://api.spotify.com/v1';
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];
const HOSTS = new Set(['accounts.spotify.com', 'api.spotify.com']);

export const SPOTIFY_NO_CLIENT =
  'Spotify no está configurado: falta PA_SPOTIFY_CLIENT_ID en el .env del PC. Los pasos (5 minutos, gratis) están en docs/SETUP-INTEGRACIONES.md, apartado Spotify.';
export const SPOTIFY_NOT_CONNECTED =
  'Spotify no está conectado todavía. Escribe /spotify conectar y acepta el permiso en el navegador del PC.';

export interface SpotifyVault {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<unknown>;
}

export interface SpotifyDeps {
  env: NodeJS.ProcessEnv;
  vault: SpotifyVault;
  fetch?: typeof fetch;
  now?: () => number;
}

export class SpotifyError extends Error {}

export function spotifyClientId(env: NodeJS.ProcessEnv): string {
  const id = (env.PA_SPOTIFY_CLIENT_ID ?? '').trim();
  return /^[0-9a-zA-Z]{16,64}$/.test(id) ? id : '';
}

/** Puerto de vuelta registrado en la app de Spotify: http://127.0.0.1:<puerto>/callback. */
export function spotifyRedirectUri(env: NodeJS.ProcessEnv): string {
  const n = Number((env.PA_SPOTIFY_REDIRECT_PORT ?? '').trim());
  const port = Number.isInteger(n) && n > 1023 && n < 65536 ? n : 8888;
  return `http://127.0.0.1:${port}/callback`;
}

function sfetch(deps: Pick<SpotifyDeps, 'fetch'>, url: string, init?: RequestInit) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname))
    throw new SpotifyError('Destino no permitido.');
  return (deps.fetch ?? fetch)(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
}

async function tokenCall(deps: SpotifyDeps, body: Record<string, string>) {
  let res: Response;
  try {
    res = await sfetch(deps, SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  } catch {
    throw new SpotifyError('No llego a Spotify (¿sin conexión?). Prueba en un rato.');
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

export interface SpotifyFlow {
  url: string;
  done: Promise<void>;
  close: () => void;
}

/**
 * Abre 127.0.0.1:<puerto>/callback, devuelve el enlace de permiso y espera la vuelta.
 * Comprueba `state`, cambia el código con el verificador PKCE y guarda el refresh token.
 */
export async function startSpotifyLogin(
  deps: SpotifyDeps,
  opts: { timeoutMs?: number } = {},
): Promise<SpotifyFlow> {
  const clientId = spotifyClientId(deps.env);
  if (!clientId) throw new SpotifyError(SPOTIFY_NO_CLIENT);
  const redirectUri = spotifyRedirectUri(deps.env);
  const port = Number(new URL(redirectUri).port);
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    finish = res;
    fail = rej;
  });
  done.catch(() => {});
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reply = (text: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><p style="font:18px sans-serif">${text}</p>`);
    };
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    if (u.searchParams.get('state') !== state) {
      reply('Enlace no válido. Pide otro con /spotify conectar.');
      return;
    }
    const code = u.searchParams.get('code');
    if (!code) {
      reply('No se ha dado permiso. Puedes cerrar esta pestaña.');
      close();
      fail(new SpotifyError('No has dado permiso a Spotify.'));
      return;
    }
    tokenCall(deps, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    })
      .then(async ({ status, json }) => {
        if (status !== 200 || typeof json.refresh_token !== 'string')
          throw new SpotifyError('Spotify no ha dado acceso. Revisa la Redirect URI de tu app.');
        await deps.vault.set(SPOTIFY_KEYS.refreshToken, json.refresh_token);
        reply('Listo, Spotify conectado. Ya puedes cerrar esta pestaña.');
        finish();
      })
      .catch((err: Error) => {
        reply('No se ha podido conectar con Spotify. Inténtalo otra vez.');
        fail(err);
      })
      .finally(close);
  });
  const timer = setTimeout(() => {
    close();
    fail(
      new SpotifyError(
        'Ha caducado el enlace de Spotify (5 min). Pide otro con /spotify conectar.',
      ),
    );
  }, opts.timeoutMs ?? 300_000);
  timer.unref?.();
  function close() {
    clearTimeout(timer);
    server.close();
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', () =>
      reject(
        new SpotifyError(
          `El puerto ${port} del PC está ocupado. Cambia PA_SPOTIFY_REDIRECT_PORT (y la Redirect URI de tu app de Spotify).`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SPOTIFY_SCOPES.join(' '),
    state,
  });
  return { url: `${SPOTIFY_AUTH_URL}?${q}`, done, close };
}

let cache: { token: string; until: number } | undefined;
export function resetSpotifyCacheForTests(): void {
  cache = undefined;
}

async function accessToken(deps: SpotifyDeps): Promise<string> {
  const clientId = spotifyClientId(deps.env);
  if (!clientId) throw new SpotifyError(SPOTIFY_NO_CLIENT);
  const now = (deps.now ?? Date.now)();
  if (cache && cache.until > now) return cache.token;
  const refresh = await deps.vault.get(SPOTIFY_KEYS.refreshToken);
  if (!refresh) throw new SpotifyError(SPOTIFY_NOT_CONNECTED);
  const { status, json } = await tokenCall(deps, {
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
  });
  if (status === 400 && json.error === 'invalid_grant') {
    await deps.vault.delete(SPOTIFY_KEYS.refreshToken);
    throw new SpotifyError(`Spotify ha retirado el permiso. ${SPOTIFY_NOT_CONNECTED}`);
  }
  if (status !== 200 || typeof json.access_token !== 'string')
    throw new SpotifyError('Spotify no responde ahora mismo. Prueba en un rato.');
  // Con PKCE Spotify puede rotar el refresh token: se guarda el nuevo.
  if (typeof json.refresh_token === 'string' && json.refresh_token !== refresh)
    await deps.vault.set(SPOTIFY_KEYS.refreshToken, json.refresh_token);
  const secs = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  cache = { token: json.access_token, until: now + Math.max(0, secs - 60) * 1000 };
  return cache.token;
}

async function api(
  deps: SpotifyDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await accessToken(deps);
  let res: Response;
  try {
    res = await sfetch(deps, `${SPOTIFY_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SpotifyError('No llego a Spotify (¿sin conexión?).');
  }
  const json = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (res.status === 401) {
    cache = undefined;
    throw new SpotifyError(`Spotify ha caducado la sesión. ${SPOTIFY_NOT_CONNECTED}`);
  }
  if (res.status === 403) {
    throw new SpotifyError(
      'Spotify no me deja controlar la música: hace falta una cuenta Premium (y que tu correo esté en «User Management» de tu app si está en modo desarrollo).',
    );
  }
  if (res.status === 404) {
    throw new SpotifyError(
      'No hay ningún Spotify activo. Abre Spotify en el PC, el móvil o la tele y dale a play una vez, o dime en qué dispositivo («pon Spotify en el PC»).',
    );
  }
  if (res.status === 429)
    throw new SpotifyError('Spotify me pide que espere un poco. Prueba en un minuto.');
  if (res.status >= 400) throw new SpotifyError(`Spotify ha respondido ${res.status}.`);
  return { status: res.status, json };
}

interface Device {
  id: string;
  name: string;
  type: string;
  active: boolean;
  volume: number | null;
}

export async function devices(deps: SpotifyDeps): Promise<Device[]> {
  const { json } = await api(deps, 'GET', '/me/player/devices');
  const list = Array.isArray(json.devices) ? json.devices : [];
  return list.map((d: Record<string, unknown>) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    type: String(d.type ?? ''),
    active: d.is_active === true,
    volume: typeof d.volume_percent === 'number' ? d.volume_percent : null,
  }));
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** «el PC», «móvil», «tele», o parte del nombre → el dispositivo; undefined si no hay. */
export function pickDevice(list: Device[], want: string): Device | undefined {
  const w = fold(want).replace(/^(el|la|mi)\s+/, '');
  if (!w) return undefined;
  const alias: Record<string, string> = {
    pc: 'computer',
    ordenador: 'computer',
    portatil: 'computer',
    movil: 'smartphone',
    telefono: 'smartphone',
    tele: 'tv',
    television: 'tv',
    altavoz: 'speaker',
  };
  const type = alias[w];
  return (
    list.find((d) => fold(d.name) === w) ??
    list.find((d) => fold(d.name).includes(w)) ??
    (type ? list.find((d) => fold(d.type) === type) : undefined)
  );
}

function trackLine(item: Record<string, unknown> | undefined): string {
  if (!item) return '';
  const artists = Array.isArray(item.artists)
    ? item.artists.map((a: Record<string, unknown>) => String(a.name ?? '')).filter(Boolean)
    : [];
  return `«${String(item.name ?? '?')}»${artists.length ? ` de ${artists.join(', ')}` : ''}`;
}

export type SpotifyAction =
  | 'estado'
  | 'play'
  | 'pausa'
  | 'siguiente'
  | 'anterior'
  | 'pon'
  | 'volumen'
  | 'dispositivos'
  | 'usar_dispositivo';

export interface SpotifyArgs {
  action: SpotifyAction;
  query?: string;
  tipo?: 'cancion' | 'artista' | 'album' | 'playlist';
  dispositivo?: string;
  volumen?: number;
}

const SEARCH_TYPE = {
  cancion: 'track',
  artista: 'artist',
  album: 'album',
  playlist: 'playlist',
} as const;

/** Ejecuta una acción y devuelve la frase en castellano para el dueño. */
export async function spotifyDo(deps: SpotifyDeps, a: SpotifyArgs): Promise<string> {
  try {
    let deviceQ = '';
    if (a.dispositivo && a.action !== 'usar_dispositivo') {
      const d = pickDevice(await devices(deps), a.dispositivo);
      if (!d)
        return `No veo «${a.dispositivo}» entre tus dispositivos de Spotify. Ábrelo allí primero.`;
      deviceQ = `?device_id=${encodeURIComponent(d.id)}`;
    }
    switch (a.action) {
      case 'estado': {
        const { status, json } = await api(deps, 'GET', '/me/player');
        if (status === 204 || !json.item) return 'Ahora mismo no suena nada en Spotify.';
        const dev = (json.device ?? {}) as Record<string, unknown>;
        return `${json.is_playing ? '▶️ Suena' : '⏸️ En pausa'}: ${trackLine(json.item as Record<string, unknown>)}${dev.name ? ` en ${String(dev.name)}` : ''}.`;
      }
      case 'play':
        await api(deps, 'PUT', `/me/player/play${deviceQ}`);
        return '▶️ Sigo con la música.';
      case 'pausa':
        await api(deps, 'PUT', `/me/player/pause${deviceQ}`);
        return '⏸️ Pausado.';
      case 'siguiente':
        await api(deps, 'POST', `/me/player/next${deviceQ}`);
        return '⏭️ Siguiente.';
      case 'anterior':
        await api(deps, 'POST', `/me/player/previous${deviceQ}`);
        return '⏮️ Anterior.';
      case 'volumen': {
        const v = Math.round(Math.min(100, Math.max(0, Number(a.volumen))));
        if (!Number.isFinite(v)) return 'Dime el volumen de 0 a 100.';
        await api(deps, 'PUT', `/me/player/volume?volume_percent=${v}${deviceQ.replace('?', '&')}`);
        return `🔊 Volumen al ${v} %.`;
      }
      case 'dispositivos': {
        const list = await devices(deps);
        if (!list.length)
          return 'No veo ningún Spotify abierto. Abre Spotify en el PC, el móvil o la tele.';
        return `Tus dispositivos de Spotify:\n${list.map((d) => `${d.active ? '▶️' : '•'} ${d.name} (${d.type})`).join('\n')}`;
      }
      case 'usar_dispositivo': {
        const list = await devices(deps);
        const d = pickDevice(list, a.dispositivo ?? '');
        if (!d)
          return list.length
            ? `No encuentro «${a.dispositivo ?? ''}». Tengo: ${list.map((x) => x.name).join(', ')}.`
            : 'No veo ningún Spotify abierto. Abre Spotify en ese dispositivo primero.';
        await api(deps, 'PUT', '/me/player', { device_ids: [d.id], play: true });
        return `🔈 Ahora suena en ${d.name}.`;
      }
      case 'pon': {
        const q = (a.query ?? '').trim();
        if (!q) return 'Dime qué pongo: una canción, un artista, un álbum o una playlist.';
        const type = SEARCH_TYPE[a.tipo ?? 'cancion'];
        const { json } = await api(
          deps,
          'GET',
          `/search?${new URLSearchParams({ q, type, limit: '1', market: 'from_token' })}`,
        );
        const bucket = (json[`${type}s`] ?? {}) as {
          items?: Array<Record<string, unknown> | null>;
        };
        const hit = (bucket.items ?? []).find((x) => x && typeof x.uri === 'string');
        if (!hit) return `No encuentro «${q}» en Spotify.`;
        const body = type === 'track' ? { uris: [hit.uri] } : { context_uri: hit.uri };
        await api(deps, 'PUT', `/me/player/play${deviceQ}`, body);
        return `▶️ Pongo ${type === 'track' ? trackLine(hit) : `«${String(hit.name ?? q)}»`}.`;
      }
      default:
        return 'No sé hacer eso con Spotify.';
    }
  } catch (err) {
    if (err instanceof SpotifyError) return err.message;
    throw err;
  }
}
