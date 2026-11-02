/**
 * Roku (y teles con Roku dentro: TCL, Hisense...) por ECP, su API abierta en
 * la red local: HTTP en el puerto 8060, sin emparejar.
 * https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
 *
 * Solo IPs privadas (assertTvHost), timeouts cortos y sin seguir redirecciones.
 */

import type { TvApp } from './app-cache.js';
import { installedNames, lgAppIdFor, matchInstalledApp } from './driver-apps.js';
import type { TvDriver, TvDriverKey, TvDriverMedia } from './drivers.js';
import { assertTvHost } from './lgtv.js';

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

export interface RokuDeps {
  fetchImpl?: typeof fetch;
  /** Apps instaladas (guardadas por tele en el daemon); sin esto, /query/apps cada vez. */
  installedApps?: () => Promise<TvApp[]>;
}

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
    throw new RokuError(
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
  isTv: boolean;
}

/** Lee /query/device-info (para `pa tv setup-roku`): nombre, modelo, serie. */
export async function rokuDeviceInfo(host: string, deps: RokuDeps = {}): Promise<RokuInfo> {
  const xml = await ecp(host, '/query/device-info', 'GET', deps);
  const name = tag(xml, 'user-device-name') ?? tag(xml, 'friendly-device-name');
  const model = tag(xml, 'model-name');
  const serial = tag(xml, 'serial-number');
  return {
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(serial ? { serial } : {}),
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
    power: (on) => press(on ? 'PowerOn' : 'PowerOff'),
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
    },
    apps: () => (deps.installedApps ?? (() => rokuInstalledApps(host, deps)))(),
    search: async (query, appId) => {
      // Búsqueda propia del Roku (ECP /search/browse): abre su pantalla de
      // resultados con el texto ya puesto, sin teclear letra a letra. Con una
      // app conocida (provider-id) se limita a ella y abre el resultado si lo
      // encuentra (launch=true).
      await ecp(host, rokuSearchPath(query, appId), 'POST', deps);
    },
  };
}
