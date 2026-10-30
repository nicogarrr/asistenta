// Cliente SSAP de la tele LG (re-emparejado: ver register/onNewClientKey).
/**
 * Cliente SSAP minimo para LG webOS TV: pairing PROMPT una vez (la tele
 * muestra un aviso y hay que aceptarlo con el mando) y requests con la
 * client-key resultante. Protocolo verificado contra bscpylgtv
 * (webos_client.py + endpoints.py): wss://IP:3001 con cert autofirmado
 * (rejectUnauthorized: false), fallback ws://IP:3000 SOLO en el pairing
 * (ver nota de downgrade mas abajo).
 *
 * La client-key NO caduca con el modo developer: vive hasta que la tele
 * restablezca ajustes o revoque el dispositivo. Se guarda en el vault local
 * (tv:host, tv:clientKey, tv:secure) desde el CLI.
 */

import https from 'node:https';
import WebSocket from 'ws';
import { TV_MANIFEST } from './manifest.js';

/** Primer pairing: hay que aceptar el aviso en la tele con el mando. */
const PAIR_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CMD_TIMEOUT_MS = 10_000;
/** Espera para aceptar con el mando el aviso de re-emparejamiento (tele que olvido la clave). */
const PROMPT_WAIT_MS = 60_000;
const CLIENT_KEY_MAX = 512;

/** Subconjunto de ws que usa el cliente (inyectable en tests). */
export interface TvSocket {
  once(event: 'open' | 'error', cb: (...args: unknown[]) => void): void;
  on(event: 'message' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
  off?(event: 'message' | 'error' | 'close' | 'open', cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  terminate?(): void;
}

export type TvSocketFactory = (url: string) => TvSocket;

/** Subconjunto de ws que usa el socket de input de botones (tvKey). */
export interface TvInputSocket {
  on(event: 'open' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}

export type TvInputSocketFactory = (url: string) => TvInputSocket;

/** Esperas de tvKey por defecto (comportamiento comprobado en la tele real). */
export const TV_KEY_TIMEOUT_MS = 5_000;
export const TV_KEY_GRACE_MS = 800;

function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Espera de respuesta de una orden (tvRequest: toast, apagar, volumen, apps…):
 * deps.commandTimeoutMs > PA_TV_CMD_TIMEOUT_MS (2000–60000) > 10 s. Basura o
 * vacío → 10 s, igual que siempre.
 */
export function tvCommandTimeoutMs(): number {
  return envMs('PA_TV_CMD_TIMEOUT_MS', CMD_TIMEOUT_MS, 2_000, 60_000);
}

/**
 * Esperas efectivas de tvKey: deps > PA_TV_KEY_TIMEOUT_MS / PA_TV_KEY_GRACE_MS
 * > 5000/800. Acotadas (timeout 1–30 s, margen 50 ms–5 s) para que un valor
 * absurdo no deje la orden colgada ni la cierre antes de que la tele la lea.
 */
export function tvKeyTimings(deps: Pick<TvClientDeps, 'keyTimeoutMs' | 'keyGraceMs'> = {}): {
  timeoutMs: number;
  graceMs: number;
} {
  const clamp = (v: number | undefined, fb: number, min: number, max: number) =>
    v !== undefined && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  return {
    timeoutMs: clamp(
      deps.keyTimeoutMs,
      envMs('PA_TV_KEY_TIMEOUT_MS', TV_KEY_TIMEOUT_MS, 1_000, 30_000),
      1_000,
      30_000,
    ),
    graceMs: clamp(
      deps.keyGraceMs,
      envMs('PA_TV_KEY_GRACE_MS', TV_KEY_GRACE_MS, 50, 5_000),
      50,
      5_000,
    ),
  };
}

export interface TvClientDeps {
  factory?: TvSocketFactory;
  pairTimeoutMs?: number;
  commandTimeoutMs?: number;
  /** Timeout total de descarga de capturas (tvScreenshot); por defecto 10s. */
  shotTimeoutMs?: number;
  /**
   * Permite el fallback ws://3000 (sin cifrar). En pairing hace falta si la
   * tele no abre 3001 (documentado: la client-key viajaria en claro por la
   * LAN, y la CLI lo registra en tv:secure). En requests con clave guardada
   * el downgrade queda PROHIBIDO salvo que la tele solo hablara ws en el
   * pairing (tv:secure=0), para no rebajar un canal ya cifrado.
   */
  allowPlaintext?: boolean;
  /** Permite un hostname no-LAN explicito (por defecto solo IPv4 privada). */
  allowNonLanHost?: boolean;
  /**
   * Reintentos de CONEXION cuando la tele rechaza o corta el socket al momento
   * (p.ej. recien despertada, el servidor SSAP aun arranca). Por defecto 1.
   * Solo se reintenta la apertura: antes del open no se ha enviado nada, asi
   * que no hay orden duplicada posible. Un timeout de apertura NO se reintenta
   * (tele apagada: ya se esperaron 5s).
   */
  connectRetries?: number;
  /** Espera entre reintentos de conexion (por defecto 600 ms). */
  connectRetryDelayMs?: number;
  /** Timeout de apertura del socket por intento (por defecto 5 s). */
  connectTimeoutMs?: number;
  /**
   * La tele ya no reconoce la client-key guardada (reinicio de fabrica, app
   * borrada…) y ha mostrado el aviso de emparejamiento: si Nico lo acepta,
   * la tele entrega una client-key NUEVA. Este callback la recibe para
   * guardarla; sin el, cada orden volveria a sacar el aviso.
   */
  onNewClientKey?: (clientKey: string) => void | Promise<void>;
  /** Espera tras el aviso de re-emparejamiento (por defecto 60 s). */
  promptWaitMs?: number;
  /** Socket de input de botones (tvKey); por defecto ws real. Inyectable en tests. */
  inputFactory?: TvInputSocketFactory;
  /** Timeout total de envio de una tecla (por defecto 5 s; PA_TV_KEY_TIMEOUT_MS). */
  keyTimeoutMs?: number;
  /** Margen tras enviar la tecla antes de cerrar (por defecto 800 ms; PA_TV_KEY_GRACE_MS). */
  keyGraceMs?: number;
}

/**
 * La tele no acepto la conexion (apagada del todo, fuera de red o arrancando):
 * no se envio NADA. Es el unico fallo SSAP ante el que tiene sentido otro
 * camino (encendido por red), porque la orden no llego.
 */
export class TvUnreachableError extends Error {
  override name = 'TvUnreachableError';
}

const defaultFactory: TvSocketFactory = (url) =>
  // La tele usa cert autofirmado: sin rejectUnauthorized el handshake TLS
  // falla. Alcance: solo esta conexion LAN; no relaja TLS de nada mas.
  new WebSocket(url, { rejectUnauthorized: false });

const PRIVATE_IPV4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

/**
 * El host se concatena en wss://${host}:3001 con TLS no verificado: tiene
 * que ser una IP privada de LAN (o hostname permitido explicitamente), sin
 * URL, credenciales, path ni puerto embebidos.
 */
export function assertTvHost(host: string, allowNonLan = false): string {
  const h = host.trim();
  if (allowNonLan) {
    if (/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(h) && !h.includes('..')) return h;
    throw new Error('Host de tele no valido: sin URL, credenciales, path ni puerto embebidos.');
  }
  if (!PRIVATE_IPV4.test(h)) {
    throw new Error(
      'Host de tele no valido: usa la IP LOCAL de la tele (p.ej. 192.168.1.237). Sin http://, sin puerto, sin path.',
    );
  }
  for (const octet of h.split('.')) {
    if (Number(octet) > 255)
      throw new Error(`Host de tele no valido: octeto ${octet} fuera de rango.`);
  }
  return h;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: la clase de control ES lo que sanitiza esta funcion
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Campo remoto arbitrario a texto seguro: nunca lanza (123, null, arrays...). */
function safeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Texto de error de la TV o la red: sin controles de terminal, sin eco de secretos, acotado. */
export function sanitizeTvText(text: string, secrets: Array<string | undefined> = []): string {
  let out = text.replace(CONTROL_CHARS, '');
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, '***');
  }
  if (out.length > 300) out = `${out.slice(0, 300)}...`;
  return out;
}

interface OpenedSocket {
  ws: TvSocket;
  secure: boolean;
}

async function openSocket(
  host: string,
  factory: TvSocketFactory,
  opts: { allowPlaintext: boolean; connectTimeoutMs?: number },
): Promise<OpenedSocket> {
  const connectTimeout = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const candidates: { url: string; secure: boolean }[] = [
    { url: `wss://${host}:3001`, secure: true },
  ];
  if (opts.allowPlaintext) candidates.push({ url: `ws://${host}:3000`, secure: false });
  let lastError: unknown;
  for (const candidate of candidates) {
    const ws = factory(candidate.url);
    // Handler de error PERMANENTE: un error del socket tras el open no debe
    // tumbar el proceso Node por falta de listener.
    ws.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(TIMEOUT_OPEN_MSG));
        }, connectTimeout);
        ws.once('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`no abre`));
        });
        // Close antes de open: rechaza AL MOMENTO, no al timeout de 5s.
        const onEarlyClose = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('cerro antes de abrir'));
        };
        ws.on('close', onEarlyClose);
      });
      return { ws, secure: candidate.secure };
    } catch (err) {
      lastError = err;
      // El intento fallido se cierra SIEMPRE: un handshake lento no puede
      // abrir tarde y convivir con la conexion del fallback.
      try {
        ws.close();
      } catch {
        // cierre best-effort
      }
      try {
        ws.terminate?.();
      } catch {
        // cierre best-effort
      }
    }
  }
  throw new TvUnreachableError(
    `No se pudo conectar con la TV en ${host} (wss://3001${opts.allowPlaintext ? ' y ws://3000' : ''}). ` +
      `¿Encendida y en la misma red? (${sanitizeTvText(lastError instanceof Error ? lastError.message : String(lastError))})`,
  );
}

const TIMEOUT_OPEN_MSG = 'timeout abriendo el canal seguro';

/**
 * openSocket con reintento SOLO ante rechazos inmediatos (error o cierre antes
 * del open): una tele recien despertada rechaza el primer intento mientras
 * arranca su servidor SSAP. Un timeout de apertura no se repite.
 */
async function openSocketRetrying(
  host: string,
  factory: TvSocketFactory,
  opts: { allowPlaintext: boolean },
  deps: TvClientDeps,
): Promise<OpenedSocket> {
  const retries = Math.max(0, deps.connectRetries ?? 1);
  const delay = Math.max(0, deps.connectRetryDelayMs ?? 600);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openSocket(host, factory, {
        ...opts,
        connectTimeoutMs: deps.connectTimeoutMs,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.message.includes(TIMEOUT_OPEN_MSG);
      if (!(err instanceof TvUnreachableError) || timedOut || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

interface SsapMessage {
  type?: string;
  id?: string;
  error?: string;
  payload?: (Record<string, unknown> & { 'client-key'?: unknown }) | null;
}

type PhaseOutcome<T> = { ok: true; value: T } | { ok: false; error: Error } | undefined;

/**
 * Espera UNA fase SSAP con cleanup robusto: timer cancelado, listeners
 * retirados y cierre/error del socket rechazando la fase (nada de esperar al
 * timeout si la tele corta). JSON null o malformado se ignora DENTRO del
 * Promise: nunca lanza fuera.
 */
function awaitPhase<T>(
  ws: TvSocket,
  timeoutMs: number,
  timeoutError: () => Error,
  handle: (msg: SsapMessage) => PhaseOutcome<T>,
  secrets: Array<string | undefined> = [],
  kick?: () => void,
  ctl?: { restart?: (ms: number) => void },
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (data: unknown) => {
      if (settled) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!raw || typeof raw !== 'object') return;
      // El handler valida payload REMOTO: si aun asi lanza (error:123 y
      // amigos), la fase falla DENTRO del Promise y el proceso no se tumba.
      let out: PhaseOutcome<T>;
      try {
        out = handle(raw as SsapMessage);
      } catch {
        out = { ok: false, error: new Error('La TV devolvio una respuesta malformada.') };
      }
      if (!out) return;
      if (out.ok) succeed(out.value);
      else fail(out.error);
    };
    const onClose = () => fail(new Error('La TV cerro la conexion.'));
    const onError = (err: unknown) =>
      fail(new Error(sanitizeTvText(err instanceof Error ? err.message : String(err), secrets)));
    let timer = setTimeout(() => fail(timeoutError()), timeoutMs);
    if (ctl) {
      // Reinicia la espera (p.ej. la tele pide aceptar un aviso con el mando).
      ctl.restart = (ms: number) => {
        if (settled) return;
        clearTimeout(timer);
        timer = setTimeout(() => fail(timeoutError()), ms);
      };
    }
    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.('message', onMessage);
      ws.off?.('close', onClose);
      ws.off?.('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
    // Un send() sincrono que lanza no puede dejar timer/listeners vivos.
    if (kick) {
      try {
        kick();
      } catch (err) {
        fail(
          new Error(
            `No se pudo enviar a la TV: ${sanitizeTvText(err instanceof Error ? err.message : String(err), secrets)}`,
          ),
        );
      }
    }
  });
}

/**
 * Registro SSAP. Sin client-key (pairingType PROMPT) la tele muestra un
 * aviso hasta que alguien lo acepta con el mando; con client-key previa es
 * inmediato. Solo se acepta el 'registered' de NUESTRO register_0, con
 * client-key de tipo y longitud validos.
 */
async function register(
  ws: TvSocket,
  clientKey: string | undefined,
  timeoutMs: number,
  promptWaitMs = PROMPT_WAIT_MS,
): Promise<string> {
  // Con client-key guardada, una respuesta PROMPT significa que la tele la ha
  // olvidado y muestra el aviso de emparejamiento: se espera a que Nico lo
  // acepte (con un mensaje claro si no lo hace) en vez de agotar el timeout
  // de la orden con un «no respondio» enganoso.
  let prompted = false;
  const ctl: { restart?: (ms: number) => void } = {};
  const pending = awaitPhase<string>(
    ws,
    timeoutMs,
    () =>
      new Error(
        prompted
          ? 'La tele ya no reconoce el emparejamiento guardado y ha mostrado un aviso: aceptalo con el mando y repite la orden, o vuelve a emparejar con: pa tv setup <ip-de-la-television>'
          : clientKey
            ? `La TV no respondio al registro en ${timeoutMs / 1000}s.`
            : `La TV no respondio en ${timeoutMs / 1000}s: en el primer emparejamiento hay que ACEPTAR el aviso que sale en la tele con el mando.`,
      ),
    (msg) => {
      if (msg.id !== 'register_0') return undefined;
      if (
        clientKey &&
        !prompted &&
        msg.type === 'response' &&
        msg.payload?.pairingType === 'PROMPT'
      ) {
        prompted = true;
        ctl.restart?.(promptWaitMs);
        return undefined;
      }
      if (msg.type === 'error') {
        return {
          ok: false,
          error: new Error(
            `La TV rechazo el registro: ${sanitizeTvText(safeText(msg.error) || 'error desconocido', [clientKey])}`,
          ),
        };
      }
      if (msg.type === 'registered') {
        const key = msg.payload?.['client-key'];
        if (
          typeof key === 'string' &&
          key.length > 0 &&
          key.length <= CLIENT_KEY_MAX &&
          !/\s/.test(key)
        ) {
          return { ok: true, value: key };
        }
        return { ok: false, error: new Error('La TV devolvio una client-key malformada.') };
      }
      return undefined;
    },
    [clientKey],
    () =>
      ws.send(
        JSON.stringify({
          type: 'register',
          id: 'register_0',
          payload: {
            'client-key': clientKey,
            forcePairing: false,
            manifest: TV_MANIFEST,
            pairingType: 'PROMPT',
          },
        }),
      ),
    ctl,
  );
  return pending;
}

export interface PairResult {
  clientKey: string;
  /** true si el pairing fue por wss (3001); false si cayo a ws (3000). */
  secure: boolean;
}

/** Emparejamiento PROMPT: devuelve la client-key que hay que persistir y el canal usado. */
export async function pairTv(host: string, deps: TvClientDeps = {}): Promise<PairResult> {
  const safeHost = assertTvHost(host, deps.allowNonLanHost ?? false);
  const opened = await openSocket(safeHost, deps.factory ?? defaultFactory, {
    allowPlaintext: deps.allowPlaintext ?? false,
  });
  try {
    const clientKey = await register(opened.ws, undefined, deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS);
    return { clientKey, secure: opened.secure };
  } finally {
    opened.ws.close();
  }
}

/** Request SSAP contra una tele ya emparejada (registro con client-key, sin aviso). */
export async function tvRequest(
  host: string,
  clientKey: string,
  uri: string,
  payload: Record<string, unknown>,
  deps: TvClientDeps = {},
): Promise<Record<string, unknown>> {
  const safeHost = assertTvHost(host, deps.allowNonLanHost ?? false);
  const opened = await openSocketRetrying(
    safeHost,
    deps.factory ?? defaultFactory,
    { allowPlaintext: deps.allowPlaintext ?? false },
    deps,
  );
  const cmdTimeout = deps.commandTimeoutMs ?? tvCommandTimeoutMs();
  try {
    const registeredKey = await register(
      opened.ws,
      clientKey,
      cmdTimeout,
      deps.promptWaitMs ?? PROMPT_WAIT_MS,
    );
    if (registeredKey !== clientKey && deps.onNewClientKey) {
      // Re-emparejada: guardar la clave nueva. Si guardarla falla, la orden
      // sigue (la sesion ya esta registrada); el siguiente uso volvera a pedir.
      try {
        await deps.onNewClientKey(registeredKey);
      } catch {
        // best-effort
      }
    }
    const id = `cmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const pending = awaitPhase<Record<string, unknown>>(
      opened.ws,
      cmdTimeout,
      () => new Error(`La TV no respondio a ${uri} en ${cmdTimeout / 1000}s.`),
      (msg) => {
        if (msg.id !== id) return undefined;
        if (msg.type === 'response') {
          const res = msg.payload;
          // Contrato SSAP: exito = returnValue===true EXPLICITO sobre un
          // payload objeto no-array. Null/missing/malformed NUNCA es exito:
          // la CLI no puede anunciar "Tele apagada" ante respuesta invalida.
          if (!res || typeof res !== 'object' || Array.isArray(res)) {
            return {
              ok: false,
              error: new Error(`La TV devolvio una respuesta invalida para ${uri}.`),
            };
          }
          if (res.returnValue !== true) {
            return {
              ok: false,
              error: new Error(
                `La TV rechazo ${uri}: ${sanitizeTvText(safeText(res.errorText) || 'not permitted', [clientKey])}`,
              ),
            };
          }
          return { ok: true, value: res };
        }
        return {
          ok: false,
          error: new Error(
            `La TV devolvio error en ${uri}: ${sanitizeTvText(safeText(msg.error) || safeText(msg.type) || 'desconocido', [clientKey])}`,
          ),
        };
      },
      [clientKey],
      () => opened.ws.send(JSON.stringify({ type: 'request', id, uri: `ssap://${uri}`, payload })),
    );
    return await pending;
  } finally {
    opened.ws.close();
  }
}

/** Toast en pantalla (quick win de la feature). */
export async function tvToast(
  host: string,
  clientKey: string,
  message: string,
  deps: TvClientDeps = {},
): Promise<void> {
  await tvRequest(host, clientKey, 'system.notifications/createToast', { message }, deps);
}

/**
 * URL devuelta por la tele por RED (imageUri, socketPath): solo se acepta si
 * apunta a la PROPIA tele (mismo host validado), con esquema y puerto
 * conocidos y sin credenciales embebidas. Cualquier otra cosa es un destino
 * arbitrario decidido por la red y se rechaza (SSRF).
 */
function parseTvUrl(value: unknown, safeHost: string, schemes: string[]): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!schemes.includes(url.protocol)) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname !== safeHost) return null;
  const port =
    url.port === ''
      ? url.protocol === 'https:' || url.protocol === 'wss:'
        ? '443'
        : '80'
      : url.port;
  if (!['80', '443', '3000', '3001'].includes(port)) return null;
  return url.toString();
}

/** Teclas validas del mando: whitelist cerrada, jamas texto libre al protocolo. */
const TV_KEY_NAMES = new Set([
  'HOME',
  'BACK',
  'EXIT',
  'ENTER',
  'LEFT',
  'RIGHT',
  'UP',
  'DOWN',
  'OK',
  'RED',
  'GREEN',
  'YELLOW',
  'BLUE',
  'INFO',
  'GUIDE',
  'MENU',
  'MUTE',
  'VOLUMEUP',
  'VOLUMEDOWN',
  'CHANNELUP',
  'CHANNELDOWN',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
]);

/**
 * Tecla del mando por el socket de input (netinput.pointer.sock): es la unica
 * via para HOME/BACK/VOLUMEN, que `system.launcher/*` no cubre. Sin esto la
 * tele se queda atrapada en la app en primer plano.
 *
 * Endurecimiento (auditor, 11 oct): el socketPath viene de RED, asi que se
 * exige mismo host que la tele pareada, esquema ws/wss y puerto conocido; el
 * nombre de tecla sale de una whitelist (un nombre con CRLF inyectaria
 * botones arbitrarios en el protocolo); y NUNCA se resuelve si el socket se
 * cerro o fallo antes de tiempo. El margen de consumo empieza SOLO tras un
 * open+send exitoso: si el handshake no abre, no hay exito que reportar.
 */
export async function tvKey(
  host: string,
  clientKey: string,
  name: string,
  deps: TvClientDeps = {},
): Promise<void> {
  const keyName = name.trim().toUpperCase();
  if (!TV_KEY_NAMES.has(keyName)) {
    throw new Error(`Tecla no valida: ${sanitizeTvText(name, [clientKey])}`);
  }
  const safeHost = assertTvHost(host, deps.allowNonLanHost ?? false);
  const res = await tvRequest(
    safeHost,
    clientKey,
    'com.webos.service.networkinput/getPointerInputSocket',
    {},
    deps,
  );
  const socketUrl = parseTvUrl((res as { socketPath?: unknown }).socketPath, safeHost, [
    'ws:',
    'wss:',
  ]);
  if (!socketUrl) throw new Error('La tele devolvio un socket de input no valido.');
  const { timeoutMs, graceMs } = tvKeyTimings(deps);
  const openInput: TvInputSocketFactory =
    deps.inputFactory ?? ((url) => new WebSocket(url, { rejectUnauthorized: false }));
  await new Promise<void>((resolve, reject) => {
    const ws = openInput(socketUrl);
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      fail(new Error('timeout enviando la tecla'));
    }, timeoutMs);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      ws.close();
      reject(err);
    };
    ws.on('open', () => {
      try {
        ws.send(`type:button\nname:${keyName}\n\n`);
      } catch {
        fail(new Error('no se pudo enviar la tecla'));
        return;
      }
      // La tele no responde nada: se da margen al consumo SOLO tras el envio
      // y se cierra. Si el socket se cierra o falla antes, la tecla no se
      // confirma.
      grace = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      }, graceMs);
    });
    ws.on('error', () => fail(new Error('no se pudo enviar la tecla')));
    ws.on('close', () => {
      if (!settled) fail(new Error('la tele cerro el socket de input antes de tiempo'));
    });
  });
}

const MAX_SHOT_BYTES = 12 * 1024 * 1024;
/** Un JPG 960x540 real son KBs; menos que esto es basura o un error de la tele. */
const MIN_SHOT_BYTES = 512;
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Captura de pantalla: `tv/executeOneShot` devuelve un imageUri HTTPS que hay
 * que descargar con TLS sin verificar (cert autofirmado de la tele).
 *
 * Limites de la plataforma, comprobados contra la tele real (OLED55C4,
 * webOS 23): el puente SSAP entrega 960x540 JPG fijo e ignora
 * width/height/format, y el contenido con DRM (Netflix, Prime, Disney+,
 * DAZN) sale en NEGRO. Eso es proteccion de LG en TVs 2020+, no un fallo:
 * para ver video protegido hace falta capturadora HDMI.
 *
 * Endurecimiento (auditor, 11 oct): el imageUri viene de RED y solo se
 * descarga si apunta a la propia tele (mismo host, https, puerto conocido,
 * sin credenciales); los redirects NO se siguen; status 200 y content-type
 * de imagen son obligatorios; se comprueba la firma JPEG/PNG completa y un
 * tamano minimo (firma comprobada, contenido NO decodificado: no se afirma
 * que sea una imagen valida); y hay un timeout TOTAL externo (no el de
 * inactividad del socket) con cleanup de request y response en todas las
 * salidas. El TLS sin verificar queda acotado a la IP de la tele pareada,
 * como el resto del cliente.
 */
export async function tvScreenshot(
  host: string,
  clientKey: string,
  deps: TvClientDeps = {},
): Promise<Buffer> {
  const safeHost = assertTvHost(host, deps.allowNonLanHost ?? false);
  const res = await tvRequest(safeHost, clientKey, 'tv/executeOneShot', {}, deps);
  const uri = parseTvUrl((res as { imageUri?: unknown }).imageUri, safeHost, ['https:']);
  if (!uri) throw new Error('La tele devolvio un imageUri no valido para la captura.');
  const timeoutMs = deps.shotTimeoutMs ?? 10_000;
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let done = false;
    let response: { destroy(): void } | undefined;
    let req: ReturnType<typeof https.get> | undefined;
    const finish = (err?: Error, buf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(totalTimer);
      if (err) {
        response?.destroy();
        req?.destroy();
        reject(err);
        return;
      }
      resolve(buf as Buffer);
    };
    // Timeout TOTAL desde el inicio: un servidor goteando bytes resetearia
    // el timeout de inactividad del socket y retendria la descarga a vida.
    const totalTimer = setTimeout(() => {
      finish(new Error(`timeout de ${timeoutMs / 1000}s descargando la captura`));
    }, timeoutMs);
    // https.get puede lanzar SINCRONO (mock o biblioteca): sin try/catch el
    // fallo escapa del Promise con el timer total vivo.
    try {
      req = https.get(uri, { rejectUnauthorized: false }, (r) => {
        response = r;
        const status = r.statusCode ?? 0;
        const type = String(r.headers['content-type'] ?? '');
        // Un 3xx cae aqui: los redirects NUNCA se siguen (destino de red).
        if (status !== 200) {
          r.resume();
          finish(new Error(`la tele respondio HTTP ${status} al descargar la captura`));
          return;
        }
        // La tele sirve el framebuffer SIN cabecera content-type, asi que
        // "ausente" es lo normal y no puede tratarse como error. Solo se
        // rechaza un content-type PRESENTE y que no sea imagen: una respuesta
        // HTML o JSON con status 200 no debe pasar por aqui. La garantia real
        // la da la firma JPEG/PNG de los bytes, que se comprueba al final.
        if (type && !type.startsWith('image/jpeg') && !type.startsWith('image/png')) {
          r.resume();
          finish(new Error(`content-type inesperado en la captura: ${sanitizeTvText(type)}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        r.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_SHOT_BYTES) {
            finish(new Error('la captura supera el tamano maximo'));
            return;
          }
          chunks.push(c);
        });
        r.on('end', () => finish(undefined, Buffer.concat(chunks)));
        r.on('aborted', () => finish(new Error('la descarga de la captura fue abortada')));
        r.on('error', () => finish(new Error('no se pudo descargar la captura')));
      });
      req.on('error', (err: unknown) => {
        finish(err instanceof Error ? err : new Error('no se pudo descargar la captura'));
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error('no se pudo iniciar la descarga'));
    }
  });
  // JPG y PNG empiezan por su firma COMPLETA: una respuesta HTML de error o
  // una respuesta de 2 bytes no deben guardarse como si fueran una imagen.
  // Se comprueba la firma, no se decodifica el contenido.
  const hasMagic = (magic: number[]): boolean => magic.every((b, i) => bytes[i] === b);
  if (bytes.length < MIN_SHOT_BYTES || (!hasMagic(JPEG_MAGIC) && !hasMagic(PNG_MAGIC))) {
    throw new Error('la captura no tiene firma JPEG/PNG completa');
  }
  return bytes;
}
