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
import type { TvApp } from './app-cache.js';
import { installedNames, lgAppIdFor, matchInstalledApp } from './driver-apps.js';
import type { TvDriver, TvDriverKey, TvDriverMedia } from './drivers.js';
import { assertTvHost, TV_SESSION_IDLE_MS, tvSessionIdleMs } from './lgtv.js';
import { netflixContentId, youtubeVideoId } from './search-recipes.js';
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

/**
 * No se llegó a conectar con la Samsung (no salió ninguna orden): apagada del
 * todo o fuera de la red. Es seguro encenderla por red y repetir.
 */
export class SamsungUnreachableError extends SamsungError {
  override name = 'SamsungUnreachableError';
  readonly unreachable = true;
}

/** Socket minimo (inyectable en tests). */
export interface SamsungSocket {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  send(data: string): void;
  close(): void;
  /** 1 = abierto (ws). Ausente en sockets de prueba: se da por abierto. */
  readyState?: number;
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
  /**
   * Conexión reutilizada entre órdenes (daemon): sin ella cada orden abre el
   * WebSocket (TLS + «ms.channel.connect»), manda y espera 300 ms para cerrar.
   */
  pool?: SamsungSessionPool | null;
  /** Apps instaladas (guardadas por tele en el daemon); sin esto, se piden a la tele. */
  installedApps?: (opts?: { fresh?: boolean }) => Promise<TvApp[]>;
  /** Espera máxima del acuse de «ed.apps.launch» (tests). */
  launchAckMs?: number;
}

export function samsungUrl(conn: SamsungConn): string {
  const host = assertTvHost(conn.host);
  const base = conn.secure
    ? `wss://${host}:8002/api/v2/channels/samsung.remote.control?name=${APP_NAME_B64}`
    : `ws://${host}:8001/api/v2/channels/samsung.remote.control?name=${APP_NAME_B64}`;
  return conn.secure && conn.token ? `${base}&token=${encodeURIComponent(conn.token)}` : base;
}

type SamsungMessage = { event?: string; data?: { token?: unknown } };

/** Espera el primer mensaje `event` que llegue a `listeners` tras `send()`, o undefined al vencer. */
function awaitReply(
  listeners: Set<(msg: SamsungMessage | null) => void>,
  send: () => void,
  event: string,
  timeoutMs: number,
): Promise<{ data: unknown } | undefined> {
  return new Promise((resolve) => {
    const l = (msg: SamsungMessage | null) => {
      if (msg?.event !== event) return;
      clearTimeout(timer);
      listeners.delete(l);
      resolve({ data: (msg as { data?: unknown }).data });
    };
    const timer = setTimeout(() => {
      listeners.delete(l);
      resolve(undefined);
    }, timeoutMs);
    listeners.add(l);
    send();
  });
}

function parse(data: unknown): SamsungMessage | null {
  try {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as SamsungMessage) : null;
  } catch {
    return null;
  }
}

/** Abre el canal y espera «ms.channel.connect». Devuelve el socket y el token visto (si hubo). */
async function openSamsung(
  conn: SamsungConn,
  deps: SamsungDeps,
): Promise<{ ws: SamsungSocket; token: string | undefined }> {
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
      finish(new SamsungUnreachableError(`No llego a la Samsung (${conn.host}): ${err.message}`)),
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
  return { ws, token };
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
  const { ws, token } = await openSamsung(conn, deps);
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

/**
 * Como samsungSend, pero con un solo mensaje y esperando su respuesta `event`
 * (hasta `timeoutMs`; undefined si la tele no contesta a eso).
 */
export async function samsungRequest(
  conn: SamsungConn,
  message: object,
  event: string,
  timeoutMs: number,
  deps: SamsungDeps = {},
): Promise<{ data: unknown } | undefined> {
  const { ws, token } = await openSamsung(conn, deps);
  const listeners = new Set<(msg: SamsungMessage | null) => void>();
  ws.on('message', (data) => {
    const msg = parse(data);
    for (const l of listeners) l(msg);
  });
  try {
    return await awaitReply(listeners, () => ws.send(JSON.stringify(message)), event, timeoutMs);
  } finally {
    try {
      ws.close();
    } catch {
      // ya cerrado
    }
    if (token && token !== conn.token) await deps.onToken?.(token);
  }
}

interface SamsungSession {
  ws: SamsungSocket;
  closed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Quien espera una respuesta de la tele por esta conexión (acuse de «ed.apps.launch»). */
  listeners: Set<(msg: SamsungMessage | null) => void>;
}

/**
 * Conexión con cada Samsung abierta entre órdenes, como TvSessionPool (#1891)
 * para la LG. Antes cada orden pagaba la apertura (TLS + espera de
 * «ms.channel.connect», ~0,3–0,8 s en casa) más 300 ms fijos antes de cerrar.
 *
 * - Se cierra sola tras `idleMs` sin usarse (PA_TV_SESSION_IDLE_MS, el mismo
 *   que la LG; 0 = sin sesión persistente).
 * - Si la tele la cierra (apagado, reposo, otra app) se tira y la siguiente
 *   orden abre otra; un socket que ya no está abierto nunca se usa para mandar
 *   (las teclas de Samsung no tienen acuse: se perderían en silencio).
 */
export class SamsungSessionPool {
  private readonly sessions = new Map<string, Promise<SamsungSession>>();
  private readonly idleMs: number;

  constructor(opts: { idleMs?: number } = {}) {
    this.idleMs = opts.idleMs ?? TV_SESSION_IDLE_MS;
  }

  size(): number {
    return this.sessions.size;
  }

  closeAll(): void {
    for (const [key, entry] of this.sessions) {
      this.sessions.delete(key);
      entry.then(
        (s) => this.drop(s),
        () => undefined,
      );
    }
  }

  private drop(s: SamsungSession, key?: string): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (key) {
      const entry = this.sessions.get(key);
      entry?.then(
        (cur) => {
          if (cur === s && this.sessions.get(key) === entry) this.sessions.delete(key);
        },
        () => undefined,
      );
    }
    if (!s.closed) {
      s.closed = true;
      try {
        s.ws.close();
      } catch {
        // ya cerrado
      }
    }
  }

  private open(conn: SamsungConn, deps: SamsungDeps, key: string): Promise<SamsungSession> {
    const entry = (async () => {
      const { ws, token } = await openSamsung(conn, deps);
      const s: SamsungSession = { ws, closed: false, listeners: new Set() };
      ws.on('message', (data) => {
        const msg = parse(data);
        for (const l of s.listeners) l(msg);
      });
      const gone = () => {
        s.closed = true;
        this.drop(s, key);
      };
      ws.on('close', gone);
      ws.on('error', gone);
      if (token && token !== conn.token) await deps.onToken?.(token);
      return s;
    })();
    this.sessions.set(key, entry);
    entry.catch(() => {
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    });
    return entry;
  }

  private usable(s: SamsungSession): boolean {
    return !s.closed && (s.ws.readyState === undefined || s.ws.readyState === 1);
  }

  private async session(conn: SamsungConn, deps: SamsungDeps): Promise<SamsungSession> {
    const key = samsungUrl(conn);
    let s = await (this.sessions.get(key) ?? this.open(conn, deps, key));
    if (!this.usable(s)) {
      this.drop(s, key);
      s = await this.open(conn, deps, key);
    }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this.drop(s, key), this.idleMs);
    s.idleTimer.unref?.();
    return s;
  }

  /** Manda los mensajes por la conexión abierta (o una nueva si no hay o ya no vale). */
  async send(
    conn: SamsungConn,
    messages: readonly object[],
    deps: SamsungDeps = {},
  ): Promise<void> {
    const s = await this.session(conn, deps);
    for (const m of messages) s.ws.send(JSON.stringify(m));
  }

  /**
   * Manda un mensaje y espera la respuesta `event` de la tele hasta `timeoutMs`.
   * Devuelve su `data` (o undefined si no contestó a tiempo: hay firmwares sin acuse).
   */
  async request(
    conn: SamsungConn,
    message: object,
    event: string,
    timeoutMs: number,
    deps: SamsungDeps = {},
  ): Promise<{ data: unknown } | undefined> {
    const s = await this.session(conn, deps);
    return awaitReply(s.listeners, () => s.ws.send(JSON.stringify(message)), event, timeoutMs);
  }
}

let sharedSamsung: SamsungSessionPool | null | undefined;

/** El pool del daemon (null si PA_TV_SESSION_IDLE_MS=0). `pa tv` no lo usa: abre y cierra. */
export function sharedSamsungPool(): SamsungSessionPool | null {
  if (sharedSamsung === undefined) {
    const idleMs = tvSessionIdleMs();
    sharedSamsung = idleMs > 0 ? new SamsungSessionPool({ idleMs }) : null;
  }
  return sharedSamsung;
}

export function samsungKey(key: string): object {
  return {
    method: 'ms.remote.control',
    params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
  };
}

const APPS_TIMEOUT_MS = 4_000;
/** Lo que se espera el acuse de «ed.apps.launch» (la tele contesta en ~0,1 s). */
const LAUNCH_ACK_MS = 1_500;
/** Teles que no acusan «ed.apps.launch» (firmwares viejos): no se les espera más. */
const NO_LAUNCH_ACK = new Set<string>();
/** Puerto DIAL de las Samsung (Application-URL http://IP:8080/ws/apps/). */
export const SAMSUNG_DIAL_PORT = 8080;
const DIAL_TIMEOUT_MS = 4_000;

/**
 * Arranca una app por DIAL (el protocolo con el que el móvil «envía» Netflix o
 * YouTube a la tele): `POST http://IP:8080/ws/apps/<App>` con el contenido en
 * el cuerpo. No pasa por el WebSocket ni por `ed.apps.launch` (que algunos
 * firmwares ignoran con contenido). Solo IPs privadas.
 */
export async function samsungDialLaunch(
  host: string,
  app: 'YouTube' | 'Netflix',
  body: string,
  deps: SamsungDeps = {},
): Promise<void> {
  const ip = assertTvHost(host);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`http://${ip}:${SAMSUNG_DIAL_PORT}/ws/apps/${app}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SamsungUnreachableError(
      `No llego a la Samsung por DIAL (${ip}:${SAMSUNG_DIAL_PORT}): ¿está encendida? (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (!res.ok) throw new SamsungError(`La Samsung no abrió ${app} (DIAL ${res.status}).`);
}

/** Id de vídeo de YouTube en lo pedido: ahora en search-recipes (lo comparten LG, Roku y Samsung). */
export { youtubeVideoId };

/**
 * Apps instaladas de verdad: «ed.installedApp.get» por el mismo canal del
 * mando; la tele contesta con `data.data = [{appId, name, app_type}]`. Abre y
 * cierra su propia conexión (la del pool solo manda, no escucha respuestas).
 */
export async function samsungInstalledApps(
  conn: SamsungConn,
  deps: SamsungDeps = {},
): Promise<TvApp[]> {
  const { ws, token } = await openSamsung(conn, deps);
  try {
    if (token && token !== conn.token) await deps.onToken?.(token);
    return await new Promise<TvApp[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SamsungError(`La Samsung (${conn.host}) no dio su lista de apps.`)),
        deps.connectTimeoutMs ?? APPS_TIMEOUT_MS,
      );
      ws.on('message', (data) => {
        const msg = parse(data) as { event?: string; data?: { data?: unknown } } | null;
        if (msg?.event !== 'ed.installedApp.get') return;
        clearTimeout(timer);
        const list = Array.isArray(msg.data?.data) ? msg.data.data : [];
        const out: TvApp[] = [];
        for (const a of list as Array<Record<string, unknown>>) {
          const id = typeof a?.appId === 'string' ? a.appId.trim() : '';
          const title = typeof a?.name === 'string' ? a.name.trim() : '';
          if (id && title && /^[\w.-]{1,64}$/.test(id)) out.push({ id, title });
        }
        resolve(out);
      });
      ws.send(
        JSON.stringify({
          method: 'ms.channel.emit',
          params: { event: 'ed.installedApp.get', to: 'host' },
        }),
      );
    });
  } finally {
    try {
      ws.close();
    } catch {
      // ya cerrado
    }
  }
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
  const send = (messages: object[]) =>
    deps.pool
      ? deps.pool.send(conn, messages, deps)
      : samsungSend(conn, messages, deps).then(() => undefined);
  const press = (key: string) => send([samsungKey(key)]);
  const listApps = deps.installedApps ?? (() => samsungInstalledApps(conn, deps));
  /**
   * Abre la app por su id y lee el acuse de la tele («ed.apps.launch», data 200;
   * otro código = ese id no existe en la tele). Si esta tele nunca acusa, no se
   * vuelve a esperar: manda y sigue, como antes.
   */
  const launchId = async (id: string): Promise<'ok' | 'missing' | 'unknown'> => {
    const message = {
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        // Las apps de la tienda (id numérico) van por DEEP_LINK; las propias
        // de Tizen («org.tizen.browser») por NATIVE_LAUNCH.
        data: { appId: id, action_type: /^\d+$/.test(id) ? 'DEEP_LINK' : 'NATIVE_LAUNCH' },
      },
    };
    if (NO_LAUNCH_ACK.has(conn.host)) {
      await send([message]);
      return 'unknown';
    }
    const waitMs = deps.launchAckMs ?? LAUNCH_ACK_MS;
    const reply = deps.pool
      ? await deps.pool.request(conn, message, 'ed.apps.launch', waitMs, deps)
      : await samsungRequest(conn, message, 'ed.apps.launch', waitMs, deps);
    if (!reply) {
      NO_LAUNCH_ACK.add(conn.host);
      return 'unknown';
    }
    const code = Number(reply.data);
    return Number.isFinite(code) && code !== 200 && code >= 400 ? 'missing' : 'ok';
  };
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
      let id = SAMSUNG_APP_IDS[lgAppIdFor(appId)];
      let installed: TvApp[] = [];
      if (!id) {
        // Apagada: «No sé abrir RTVE Play» sería falso; que se vea que no llega.
        installed = await listApps().catch((err: unknown) => {
          if (err instanceof SamsungUnreachableError) throw err;
          return [];
        });
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
        throw new SamsungError(
          names
            ? `No encuentro «${appId}» en la Samsung. Tiene: ${names}.`
            : `No sé abrir «${appId}» en la Samsung; prueba con Netflix, YouTube, Prime Video, Disney+, Spotify o Apple TV.`,
        );
      }
      if ((await launchId(id)) !== 'missing') return;
      // La tele dice que ese id no está (app desinstalada, o el id de la tienda
      // es otro en este modelo): lista fresca y, si la app sigue con otro id, ese.
      const fresh = await (deps.installedApps
        ? deps.installedApps({ fresh: true })
        : samsungInstalledApps(conn, deps)
      ).catch(() => null);
      const other = fresh ? matchInstalledApp(appId, fresh)?.id : undefined;
      if (other && other !== id && (await launchId(other)) !== 'missing') return;
      const names = fresh ? installedNames(fresh) : '';
      throw new SamsungError(
        `«${appId}» ya no está en la Samsung (¿la desinstalaste?).${names ? ` Tiene: ${names}.` : ''}`,
      );
    },
    apps: () => listApps(),
    search: async (query, appId) => {
      const q = query.trim().slice(0, 200);
      if (!q) throw new SamsungError('¿Qué busco en la Samsung? Dime el título.');
      const app = lgAppIdFor(appId ?? '');
      if (app === 'netflix') {
        // El mismo contenido «m=<url>&source_type=4» que la receta de la LG
        // (un enlace …/title/ID abre ese título; el resto se busca).
        await samsungDialLaunch(conn.host, 'Netflix', netflixContentId(q), deps);
        return;
      }
      if (app === 'youtube.leanback.v4') {
        const id = youtubeVideoId(query);
        if (id) {
          await samsungDialLaunch(conn.host, 'YouTube', `v=${id}`, deps);
          return;
        }
        throw new SamsungError(
          'La Samsung no deja buscar texto dentro de YouTube desde fuera: pásame el enlace del vídeo y lo pongo, o dime «abre YouTube» y lo buscas con el mando.',
        );
      }
      throw new SamsungError(
        'En la Samsung solo sé buscar dentro de Netflix y poner vídeos de YouTube por enlace.',
      );
    },
  };
}
