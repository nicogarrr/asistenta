/**
 * Roku (y teles con Roku dentro: TCL, Hisense...) por ECP, su API abierta en
 * la red local: HTTP en el puerto 8060, sin emparejar.
 * https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
 *
 * Solo IPs privadas (assertTvHost), timeouts cortos y sin seguir redirecciones.
 */

import type { TvApp } from './app-cache.js';
import { installedNames, lgAppIdFor, matchInstalledApp } from './driver-apps.js';
import type { TvDriver, TvDriverKey, TvDriverMedia, TvLaunchCheck } from './drivers.js';
import { assertTvHost } from './lgtv.js';
import { isYoutubeApp, netflixTitle, youtubeVideoId } from './search-recipes.js';
import { sendWakeOnLan } from './wol.js';

export const ROKU_PORT = 8060;
const ROKU_TIMEOUT_MS = 4_000;

/** appId de las LG (APP_ALIASES) → id de canal Roku. */
export const ROKU_APP_IDS: Record<string, string> = {
  netflix: '12',
  'youtube.leanback.v4': '837',
  amazon: '13',
  'com.disney.disneyplus-prod': '291097',
  'spotify-beehive': '22297',
  'com.apple.appletv': '551012',
};

const ROKU_KEYS: Record<TvDriverKey, string> = {
  BACK: 'Back',
  HOME: 'Home',
  ENTER: 'Select',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
  EXIT: 'Home',
};

const ROKU_MEDIA: Record<TvDriverMedia, string> = {
  play: 'Play',
  pause: 'Play',
  stop: 'Back',
  rewind: 'Rev',
  fastForward: 'Fwd',
};

export class RokuError extends Error {
  override name = 'RokuError';
}

/**
 * No se llegó al Roku (no contestó por la red): apagado del todo o fuera de la
 * wifi. Con su MAC se puede encender por red y repetir la orden (como la
 * Samsung desde #1943). Solo lo repiten «abre/pon…», que no hacen daño dos veces.
 */
export class RokuUnreachableError extends RokuError {
  override name = 'RokuUnreachableError';
  readonly unreachable = true;
}

export interface RokuDeps {
  fetchImpl?: typeof fetch;
  /** Apps instaladas (guardadas por tele en el daemon); sin esto, /query/apps cada vez. */
  installedApps?: (opts?: { fresh?: boolean }) => Promise<TvApp[]>;
  /** MAC guardada en `pa tv setup-roku` (de /query/device-info): encender por red. */
  mac?: string | undefined;
  wake?: (mac: string, host: string) => Promise<unknown>;
  /** Cuánto se espera a que la app abierta salga en pantalla (/query/active-app). */
  confirmMs?: number;
  confirmStepMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Lo que espera como mucho la confirmación de la app en pantalla (Netflix tarda ~1–2 s). */
const ROKU_CONFIRM_MS = 3_000;
const ROKU_CONFIRM_STEP_MS = 500;

async function ecp(
  host: string,
  path: string,
  method: 'GET' | 'POST',
  deps: RokuDeps,
): Promise<string> {
  const ip = assertTvHost(host);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`http://${ip}:${ROKU_PORT}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(ROKU_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RokuUnreachableError(
      `No llego al Roku (${ip}:${ROKU_PORT}): ¿está encendido y en la misma wifi? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (res.status === 403) {
    throw new RokuError(
      'El Roku rechaza el control por red: actívalo en Ajustes > Sistema > Ajustes avanzados > Control por apps móviles > Acceso a la red: Permitido.',
    );
  }
  if (!res.ok) throw new RokuError(`El Roku contestó ${res.status} a ${path.split('?')[0]}.`);
  return res.text();
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
  return m?.[1]?.trim() || undefined;
}

export interface RokuInfo {
  name?: string;
  model?: string;
  serial?: string;
  /** MAC de la red por la que está conectado (wifi o cable), para encenderlo por red. */
  mac?: string;
  isTv: boolean;
}

/** MAC válida en minúsculas (aa:bb:…), o undefined. */
function cleanMac(raw: string | undefined): string | undefined {
  const mac = raw?.trim().toLowerCase().replace(/-/g, ':');
  if (!mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) return undefined;
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return undefined;
  return mac;
}

/** Lee /query/device-info (para `pa tv setup-roku`): nombre, modelo, serie. */
export async function rokuDeviceInfo(host: string, deps: RokuDeps = {}): Promise<RokuInfo> {
  const xml = await ecp(host, '/query/device-info', 'GET', deps);
  const name = tag(xml, 'user-device-name') ?? tag(xml, 'friendly-device-name');
  const model = tag(xml, 'model-name');
  const serial = tag(xml, 'serial-number');
  // La MAC de la red por la que contesta ahora: el paquete mágico va a esa tarjeta.
  const wifi = cleanMac(tag(xml, 'wifi-mac'));
  const eth = cleanMac(tag(xml, 'ethernet-mac'));
  const mac = tag(xml, 'network-type') === 'ethernet' ? (eth ?? wifi) : (wifi ?? eth);
  return {
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
    isTv: tag(xml, 'is-tv') === 'true',
  };
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * App en pantalla: GET /query/active-app (`<app id="12" …>Netflix</app>`; en el
 * inicio `<app>Roku</app>`, sin id). null si la respuesta no se entiende.
 */
export async function rokuActiveApp(
  host: string,
  deps: RokuDeps = {},
): Promise<{ id: string | null; title: string } | null> {
  const xml = await ecp(host, '/query/active-app', 'GET', deps);
  const m = /<app\b([^>]*)>([^<]*)<\/app>/i.exec(xml);
  if (!m) return null;
  const id = /\bid="([^"]+)"/i.exec(m[1] ?? '')?.[1]?.trim() ?? null;
  return { id, title: unescapeXml((m[2] ?? '').trim()) || 'Roku' };
}

/**
 * Espera a que `id` salga en pantalla (hasta confirmMs). undefined si el Roku
 * no lo dice (respuesta rara o error): entonces no se afirma nada.
 */
async function confirmForeground(
  host: string,
  id: string,
  deps: RokuDeps,
): Promise<TvLaunchCheck | undefined> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (deps.confirmMs ?? ROKU_CONFIRM_MS);
  for (;;) {
    const active = await rokuActiveApp(host, deps).catch(() => null);
    if (!active) return undefined;
    if (active.id === id) return { title: active.title, foreground: true };
    if (Date.now() >= deadline) return { foreground: false, showing: active.title };
    await sleep(deps.confirmStepMs ?? ROKU_CONFIRM_STEP_MS);
  }
}

/** Apps instaladas de verdad: GET /query/apps (`<app id="12" …>Netflix</app>`). */
export async function rokuInstalledApps(host: string, deps: RokuDeps = {}): Promise<TvApp[]> {
  const xml = await ecp(host, '/query/apps', 'GET', deps);
  const out: TvApp[] = [];
  for (const m of xml.matchAll(/<app\b([^>]*)>([^<]*)<\/app>/gi)) {
    const id = /\bid="([^"]+)"/i.exec(m[1] ?? '')?.[1]?.trim();
    const title = unescapeXml((m[2] ?? '').trim());
    if (id && title && /^[\w.-]{1,64}$/.test(id)) out.push({ id, title });
  }
  return out;
}

/** Ruta ECP de búsqueda: /search/browse?keyword=…[&provider-id=…&launch=true]. */
export function rokuSearchPath(query: string, appId?: string): string {
  const keyword = query.trim().slice(0, 100);
  if (!keyword) throw new RokuError('¿Qué busco en el Roku? Dime el título.');
  const params = new URLSearchParams({ keyword });
  const provider = appId ? ROKU_APP_IDS[lgAppIdFor(appId)] : undefined;
  if (provider) {
    params.set('provider-id', provider);
    params.set('launch', 'true');
  }
  return `/search/browse?${params.toString()}`;
}

export function rokuDriver(host: string, deps: RokuDeps = {}): TvDriver {
  const press = (key: string) => ecp(host, `/keypress/${key}`, 'POST', deps).then(() => undefined);
  return {
    brand: 'Roku',
    power: async (on) => {
      if (!on || !deps.mac) return press(on ? 'PowerOn' : 'PowerOff');
      // Apagado del todo (sin «Inicio rápido de la TV») el ECP no contesta: el
      // paquete mágico primero; si ya estaba en reposo, PowerOn lo enciende.
      await (deps.wake ?? ((mac: string, ip: string) => sendWakeOnLan(mac, { host: ip })))(
        deps.mac,
        host,
      );
      try {
        await press('PowerOn');
      } catch (err) {
        // Sigue arrancando: el paquete ya salió; quien repite la orden espera.
        if (!(err instanceof RokuUnreachableError)) throw err;
      }
    },
    volumeStep: async (steps) => {
      for (let i = 0; i < Math.abs(steps); i++) await press(steps > 0 ? 'VolumeUp' : 'VolumeDown');
    },
    mute: async () => {
      await press('VolumeMute');
      return { toggles: true };
    },
    key: (name) => press(ROKU_KEYS[name]),
    media: (command) => press(ROKU_MEDIA[command]),
    launch: async (appId) => {
      let id = ROKU_APP_IDS[lgAppIdFor(appId)];
      let installed: TvApp[] = [];
      if (!id) {
        installed = await (deps.installedApps ?? (() => rokuInstalledApps(host, deps)))().catch(
          () => [],
        );
        id = matchInstalledApp(appId, installed)?.id;
        // La lista guardada (12 h) no tiene una app recién instalada: se pide otra vez, una.
        if (!id && deps.installedApps) {
          const fresh = await deps.installedApps({ fresh: true }).catch(() => null);
          if (fresh) {
            installed = fresh;
            id = matchInstalledApp(appId, fresh)?.id;
          }
        }
      }
      if (!id) {
        const names = installedNames(installed);
        throw new RokuError(
          names
            ? `No encuentro «${appId}» en el Roku. Tiene: ${names}.`
            : `No sé abrir «${appId}» en el Roku; prueba con Netflix, YouTube, Prime Video, Disney+, Spotify o Apple TV.`,
        );
      }
      await ecp(host, `/launch/${encodeURIComponent(id)}`, 'POST', deps);
      // ¿Ha salido de verdad? (antes se decía «abriendo» sin mirar).
      return confirmForeground(host, id, deps);
    },
    apps: () => (deps.installedApps ?? (() => rokuInstalledApps(host, deps)))(),
    search: async (query, appId) => {
      // Búsqueda propia del Roku (ECP /search/browse): abre su pantalla de
      // resultados con el texto ya puesto, sin teclear letra a letra. Con una
      // app conocida (provider-id) se limita a ella y abre el resultado si lo
      // encuentra (launch=true).
      // Un enlace de YouTube: deep link ECP al vídeo (launch con contentId y
      // mediaType, el formato que documenta Roku), no buscar el texto del enlace.
      const video = appId && isYoutubeApp(lgAppIdFor(appId)) ? youtubeVideoId(query) : null;
      if (video) {
        const yt = ROKU_APP_IDS['youtube.leanback.v4'];
        const params = new URLSearchParams({ contentId: video, mediaType: 'movie' });
        await ecp(host, `/launch/${yt}?${params.toString()}`, 'POST', deps);
        return yt ? confirmForeground(host, yt, deps) : undefined;
      }
      // Un enlace de Netflix (…/title/ID): deep link ECP a ese título, no una
      // búsqueda del texto del enlace.
      const title = appId && lgAppIdFor(appId) === 'netflix' ? netflixTitle(query) : null;
      if (title) {
        const params = new URLSearchParams({ contentId: title.id, mediaType: 'movie' });
        await ecp(host, `/launch/${ROKU_APP_IDS.netflix}?${params.toString()}`, 'POST', deps);
        return ROKU_APP_IDS.netflix
          ? confirmForeground(host, ROKU_APP_IDS.netflix, deps)
          : undefined;
      }
      await ecp(host, rokuSearchPath(query, appId), 'POST', deps);
    },
  };
}
