/**
 * Samsung Tizen (2016+) por su API local de mando a distancia: WebSocket
 * en wss://IP:8002 (con token, la tele pide «Permitir» la primera vez) o
 * ws://IP:8001 en modelos sin token. Sin dependencias nuevas: el mismo `ws`
 * que usa la LG. Info del aparato en http://IP:8001/api/v2/ (nombre, modelo,
 * MAC para el encendido por red y si usa token).
 *
 * Solo IPs privadas (assertTvHost). El cert de la tele es autofirmado: el TLS
 * sin verificar se limita a esta conexion LAN, como en la LG.
 */

import WebSocket from 'ws';
import type { TvDriver, TvDriverKey, TvDriverMedia } from './drivers.js';
import { assertTvHost } from './lgtv.js';
import { sendWakeOnLan } from './wol.js';

const APP_NAME_B64 = Buffer.from('Asistenta').toString('base64');
const CONNECT_TIMEOUT_MS = 6_000;
/** La primera vez la tele espera a que el dueño pulse «Permitir». */
export const SAMSUNG_PAIR_TIMEOUT_MS = 30_000;
const SEND_GRACE_MS = 300;
const INFO_TIMEOUT_MS = 3_000;

/** appId de las LG (APP_ALIASES) → app de Tizen. */
export const SAMSUNG_APP_IDS: Record<string, string> = {
  netflix: '3201907018807',
  'youtube.leanback.v4': '111299001912',
  amazon: '3201910019365',
  'com.disney.disneyplus-prod': '3201901017640',
  'spotify-beehive': '3201606009684',
  'com.apple.appletv': '3201807016597',
};

const SAMSUNG_KEYS: Record<TvDriverKey, string> = {
  BACK: 'KEY_RETURN',
  HOME: 'KEY_HOME',
  ENTER: 'KEY_ENTER',
  UP: 'KEY_UP',
  DOWN: 'KEY_DOWN',
  LEFT: 'KEY_LEFT',
  RIGHT: 'KEY_RIGHT',
  EXIT: 'KEY_EXIT',
};

const SAMSUNG_MEDIA: Record<TvDriverMedia, string> = {
  play: 'KEY_PLAY',
  pause: 'KEY_PAUSE',
  stop: 'KEY_STOP',
  rewind: 'KEY_REWIND',
  fastForward: 'KEY_FF',
};

export class SamsungError extends Error {
  override name = 'SamsungError';
}

/** Socket minimo (inyectable en tests). */
export interface SamsungSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
}

export type SamsungSocketFactory = (url: string) => SamsungSocket;

const defaultFactory: SamsungSocketFactory = (url) =>
  new WebSocket(url, { rejectUnauthorized: false }) as unknown as SamsungSocket;

export interface SamsungConn {
  host: string;
  /** Token guardado (vacío = sin emparejar o modelo sin token). */
  token?: string | undefined;
  /** true = wss 8002 con token; false = ws 8001 (modelos viejos). */
  secure: boolean;
}

export interface SamsungDeps {
  socketFactory?: SamsungSocketFactory;
  fetchImpl?: typeof fetch;
  /** La tele dio un token nuevo (primera vez o re-emparejada): hay que guardarlo. */
  onToken?: (token: string) => Promise<void> | void;
  /** Encendido por red (Samsung no se enciende por el WebSocket). */
  mac?: string | undefined;
  wake?: (mac: string, host: string) => Promise<unknown>;
  connectTimeoutMs?: number;
  graceMs?: number;
}

export function samsungUrl(conn: SamsungConn): string {
  const host = assertTvHost(conn.host);
  const base = conn.secure
    ? `wss://${host}:8002/api/v2/channels/samsung.remote.control?name=${APP_NAME_B64}`
    : `ws://${host}:8001/api/v2/channels/samsung.remote.control?name=${APP_NAME_B64}`;
  return conn.secure && conn.token ? `${base}&token=${encodeURIComponent(conn.token)}` : base;
}

function parse(data: unknown): { event?: string; data?: { token?: unknown } } | null {
  try {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object'
      ? (v as { event?: string; data?: { token?: unknown } })
      : null;
  } catch {
    return null;
  }
}

/**
 * Abre el canal, espera «ms.channel.connect» (con token si la tele lo da),
 * manda los mensajes y cierra. Devuelve el token visto (si hubo).
 */
export async function samsungSend(
  conn: SamsungConn,
  messages: readonly object[],
  deps: SamsungDeps = {},
): Promise<string | undefined> {
  const url = samsungUrl(conn);
  const ws = (deps.socketFactory ?? defaultFactory)(url);
  const timeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const token = await new Promise<string | undefined>((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, tok?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        try {
          ws.close();
        } catch {
          // ya cerrado
        }
        reject(err);
      } else resolve(tok);
    };
    const timer = setTimeout(
      () =>
        finish(
          new SamsungError(
            `La Samsung (${conn.host}) no contestó en ${Math.round(timeoutMs / 1000)} s: ¿está encendida y en la misma wifi? Si es la primera vez, acepta el aviso en la tele.`,
          ),
        ),
      timeoutMs,
    );
    ws.on('error', (err) =>
      finish(new SamsungError(`No llego a la Samsung (${conn.host}): ${err.message}`)),
    );
    ws.on('close', () =>
      finish(
        new SamsungError(`La Samsung (${conn.host}) cerró la conexión antes de aceptar órdenes.`),
      ),
    );
    ws.on('message', (data) => {
      const msg = parse(data);
      if (msg?.event === 'ms.channel.unauthorized') {
        finish(
          new SamsungError(
            'La Samsung ha rechazado el control: en la tele, Ajustes > General > Gestor de dispositivos externos > Gestor de conexión de dispositivos, permite «Asistenta» y repite «pa tv setup-samsung».',
          ),
        );
      } else if (msg?.event === 'ms.channel.connect') {
        const tok = msg.data?.token;
        finish(
          null,
          typeof tok === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(tok) ? tok : undefined,
        );
      }
    });
  });
  for (const m of messages) ws.send(JSON.stringify(m));
  await new Promise((r) => setTimeout(r, deps.graceMs ?? SEND_GRACE_MS));
  try {
    ws.close();
  } catch {
    // ya cerrado
  }
  if (token && token !== conn.token) await deps.onToken?.(token);
  return token;
}

export function samsungKey(key: string): object {
  return {
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
  };
}

export interface SamsungInfo {
  name?: string;
  model?: string;
  mac?: string;
  /** La tele usa token (wss 8002). */
  tokenAuth: boolean;
}

/** GET http://IP:8001/api/v2/ (para `pa tv setup-samsung`). */
export async function samsungDeviceInfo(
  host: string,
  deps: SamsungDeps = {},
): Promise<SamsungInfo> {
  const ip = assertTvHost(host);
  let body: unknown;
  try {
    const res = await (deps.fetchImpl ?? fetch)(`http://${ip}:8001/api/v2/`, {
      redirect: 'error',
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new SamsungError(
      `No llego a la Samsung (${ip}:8001): ¿está encendida y en la misma wifi? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const device = ((body as { device?: Record<string, unknown> })?.device ?? {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const name = str(device.name) ?? str((body as { name?: unknown })?.name);
  const model = str(device.modelName);
  const mac = str(device.wifiMac);
  return {
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(mac && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) ? { mac: mac.toLowerCase() } : {}),
    tokenAuth: String(device.TokenAuthSupport) === 'true',
  };
}

export function samsungDriver(conn: SamsungConn, deps: SamsungDeps = {}): TvDriver {
  const send = (messages: object[]) => samsungSend(conn, messages, deps).then(() => undefined);
  const press = (key: string) => send([samsungKey(key)]);
  return {
    brand: 'Samsung',
    power: async (on) => {
      if (on) {
        // Apagada no hay WebSocket: se enciende por red con su MAC.
        if (!deps.mac) {
          throw new SamsungError(
            'Para encender la Samsung por red necesito su MAC: repite «pa tv setup-samsung <ip>» con la tele encendida.',
          );
        }
        await (deps.wake ?? ((mac: string, host: string) => sendWakeOnLan(mac, { host })))(
          deps.mac,
          conn.host,
        );
        return;
      }
      await press('KEY_POWER');
    },
    volumeStep: (steps) =>
      send(
        Array.from({ length: Math.abs(steps) }, () =>
          samsungKey(steps > 0 ? 'KEY_VOLUP' : 'KEY_VOLDOWN'),
        ),
      ),
    mute: async () => {
      await press('KEY_MUTE');
      return { toggles: true };
    },
    key: (name) => press(SAMSUNG_KEYS[name]),
    media: (command) => press(SAMSUNG_MEDIA[command]),
    launch: async (appId) => {
      const id = SAMSUNG_APP_IDS[appId];
      if (!id) {
        throw new SamsungError(
          `No sé abrir «${appId}» en la Samsung; prueba con Netflix, YouTube, Prime Video, Disney+, Spotify o Apple TV.`,
        );
      }
      await send([
        {
          method: 'ms.channel.emit',
          params: {
            event: 'ed.apps.launch',
            to: 'host',
            data: { appId: id, action_type: 'DEEP_LINK' },
          },
        },
      ]);
    },
  };
}
