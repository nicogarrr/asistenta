/**
 * Roku (y teles con Roku dentro: TCL, Hisense...) por ECP, su API abierta en
 * la red local: HTTP en el puerto 8060, sin emparejar.
 * https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md
 *
 * Solo IPs privadas (assertTvHost), timeouts cortos y sin seguir redirecciones.
 */

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
      const id = ROKU_APP_IDS[appId];
      if (!id)
        throw new RokuError(
          `No sé abrir «${appId}» en el Roku; prueba con Netflix, YouTube, Prime Video, Disney+, Spotify o Apple TV.`,
        );
      await ecp(host, `/launch/${id}`, 'POST', deps);
    },
  };
}
