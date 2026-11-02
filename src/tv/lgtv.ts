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
/** Reintentos de apertura ante rechazo inmediato y espera base (se dobla). */
const CONNECT_RETRIES = 2;
const CONNECT_RETRY_DELAY_MS = 500;
const CMD_TIMEOUT_MS = 10_000;
/** Espera para aceptar con el mando el aviso de re-emparejamiento (tele que olvido la clave). */
const PROMPT_WAIT_MS = 60_000;
const CLIENT_KEY_MAX = 512;

/** Subconjunto de ws que usa el cliente (inyectable en tests). */
export interface TvSocket {
  once(event: 'open' | 'error', cb: (...args: unknown[]) => void): void;
  on(event: 'message' | 'error' | 'close' | 'pong', cb: (...args: unknown[]) => void): void;
  off?(
    event: 'message' | 'error' | 'close' | 'open' | 'pong',
    cb: (...args: unknown[]) => void,
  ): void;
  send(data: string): void;
  close(): void;
  terminate?(): void;
  /** ws real: ping de protocolo (la tele contesta 'pong'); se usa para ver si una sesión guardada sigue viva. */
  ping?(): void;
}

export type TvSocketFactory = (url: string) => TvSocket;

/** Subconjunto de ws que usa el socket de input de botones (tvKey). */
export interface TvInputSocket {
  on(event: 'open' | 'error' | 'close' | 'pong', cb: (...args: unknown[]) => void): void;
  off?(event: 'open' | 'error' | 'close' | 'pong', cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  ping?(): void;
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
   * (p.ej. recien despertada, el servidor SSAP aun arranca). Por defecto 2
   * (3 intentos). Solo se reintenta la apertura: antes del open no se ha
   * enviado nada, asi que no hay orden duplicada posible. Un timeout de
   * apertura NO se reintenta (tele apagada: ya se esperaron 5s).
   */
  connectRetries?: number;
  /**
   * Espera antes del primer reintento de conexion (por defecto 500 ms); cada
   * reintento siguiente espera el doble (500 ms, 1 s).
   */
  connectRetryDelayMs?: number;
  /** Timeout de apertura del socket por intento (por defecto 5 s). */
  connectTimeoutMs?: number;
  /**
   * Pausa entre teclas de una ráfaga (tvKeys); por defecto
   * PA_TV_KEY_GAP_MS o TV_KEY_GAP_MS. La tele pierde pulsaciones pegadas.
   */
  keyGapMs?: number;
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
  /**
   * Sesión persistente (solo el daemon): la conexión SSAP, el registro y el
   * socket de input se abren una vez y se reutilizan entre órdenes. Sin pool,
   * cada orden abre y cierra su conexión (comportamiento de siempre).
   */
  pool?: TvSessionPool;
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
 * del open): una tele recien despertada rechaza los primeros intentos mientras
 * arranca su servidor SSAP (hasta 2 reintentos con espera creciente). Un
 * timeout de apertura no se repite.
 */
async function openSocketRetrying(
  host: string,
  factory: TvSocketFactory,
  opts: { allowPlaintext: boolean },
  deps: TvClientDeps,
): Promise<OpenedSocket> {
  const retries = Math.max(0, deps.connectRetries ?? CONNECT_RETRIES);
  const baseDelay = Math.max(0, deps.connectRetryDelayMs ?? CONNECT_RETRY_DELAY_MS);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await openSocket(host, factory, {
        ...opts,
        connectTimeoutMs: deps.connectTimeoutMs,
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.message.includes(TIMEOUT_OPEN_MSG);
      if (!(err instanceof TvUnreachableError) || timedOut || attempt >= retries) throw err;
      // Backoff corto: una tele recien encendida puede rechazar mas de un intento.
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
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

/** Una petición SSAP sobre un socket ya registrado (con o sin sesión persistente). */
function requestOn(
  ws: TvSocket,
  clientKey: string,
  uri: string,
  payload: Record<string, unknown>,
  cmdTimeout: number,
): Promise<Record<string, unknown>> {
  const id = `cmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  return awaitPhase<Record<string, unknown>>(
    ws,
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
    () => ws.send(JSON.stringify({ type: 'request', id, uri: `ssap://${uri}`, payload })),
  );
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
  if (deps.pool) return deps.pool.request(safeHost, clientKey, uri, payload, deps);
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
    return await requestOn(opened.ws, clientKey, uri, payload, cmdTimeout);
  } finally {
    opened.ws.close();
  }
}

/** Inactividad tras la que se cierra una sesión persistente (PA_TV_SESSION_IDLE_MS; 0 = sin sesión persistente). */
export const TV_SESSION_IDLE_MS = 60_000;
/** Sesión parada más que esto: antes de reutilizarla se comprueba con un ping que sigue viva. */
export const TV_SESSION_PING_AFTER_MS = 5_000;
const TV_SESSION_PING_TIMEOUT_MS = 1_500;

/** PA_TV_SESSION_IDLE_MS: 0 desactiva la sesión persistente; si no, 5 s–10 min (60 s por defecto). */
export function tvSessionIdleMs(): number {
  const raw = process.env.PA_TV_SESSION_IDLE_MS?.trim();
  if (raw === '0') return 0;
  return envMs('PA_TV_SESSION_IDLE_MS', TV_SESSION_IDLE_MS, 5_000, 600_000);
}

/** URIs de solo lectura: tras un corte en una sesión reutilizada se pueden repetir sin riesgo. */
const READ_ONLY_URI = /\/(get|list)[A-Za-z]*$|^tv\/executeOneShot$/;

interface PooledInput {
  ws: TvInputSocket;
  closed: boolean;
  lastUsed: number;
  lastKeyAt: number;
}

interface PooledSession {
  ws: TvSocket;
  host: string;
  closed: boolean;
  lastUsed: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  input?: PooledInput;
  /** Registrada con otra client-key (re-emparejada): sirve para esta orden y no se guarda. */
  rekeyed?: boolean;
}

export interface TvSessionPoolOptions {
  idleMs?: number;
  pingAfterMs?: number;
  keyGapMs?: number;
  now?: () => number;
}

/** ¿Sigue vivo? ping de protocolo con espera corta; un socket sin ping (fakes) se da por vivo. */
function stillAlive(ws: TvSocket | TvInputSocket, timeoutMs: number): Promise<boolean> {
  if (typeof ws.ping !== 'function' || typeof ws.off !== 'function') return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.off?.('pong', onPong);
      resolve(ok);
    };
    const onPong = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on('pong', onPong);
    try {
      ws.ping?.();
    } catch {
      finish(false);
    }
  });
}

/**
 * Sesiones SSAP persistentes por tele (host + client-key + canal).
 *
 * Antes cada orden abría wss, repetía el registro y cerraba; cada tecla además
 * pedía el socket de input, lo abría y esperaba 800 ms antes de cerrarlo
 * (~1,4 s por tecla). Aquí la conexión registrada y el socket de input se
 * guardan y se cierran solos tras `idleMs` sin uso. Reglas de seguridad:
 * - Una sesión parada más de `pingAfterMs` se comprueba con un ping antes de
 *   reutilizarla; sin pong, se tira y se abre otra (no se envía nada a ciegas).
 * - Un corte o timeout tira la sesión. Solo las lecturas (get*, list*,
 *   captura) se repiten una vez en una sesión nueva; una orden (launch,
 *   tecla enviada…) nunca se repite, para no duplicarla.
 * - Si la tele entrega otra client-key (re-emparejada), esa conexión no se
 *   guarda: la siguiente orden llega con la clave nueva.
 */
export class TvSessionPool {
  private readonly sessions = new Map<string, Promise<PooledSession>>();
  private readonly answered = new Map<string, number>();
  private readonly idleMs: number;
  private readonly pingAfterMs: number;
  private readonly keyGapMs: number | undefined;
  private readonly now: () => number;

  constructor(opts: TvSessionPoolOptions = {}) {
    this.idleMs = opts.idleMs ?? TV_SESSION_IDLE_MS;
    this.pingAfterMs = opts.pingAfterMs ?? TV_SESSION_PING_AFTER_MS;
    this.keyGapMs = opts.keyGapMs;
    this.now = opts.now ?? Date.now;
  }

  /** Sesiones abiertas o abriéndose (tests y diagnóstico). */
  size(): number {
    return this.sessions.size;
  }

  /** ¿Contestó esta tele (conexión registrada o respuesta) hace menos de `ms`? */
  answeredWithin(host: string, ms: number): boolean {
    const at = this.answered.get(host);
    return at !== undefined && this.now() - at < ms;
  }

  closeAll(): void {
    for (const [key, pending] of this.sessions) {
      this.sessions.delete(key);
      pending.then(
        (s) => this.drop(s),
        () => undefined,
      );
    }
  }

  private keyOf(host: string, clientKey: string, deps: TvClientDeps): string {
    return `${host}|${deps.allowPlaintext ? 'ws' : 'wss'}|${clientKey}`;
  }

  private drop(s: PooledSession, key?: string): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (key && this.sessions.get(key)) {
      // Solo se borra si la entrada sigue siendo ESTA sesión.
      const entry = this.sessions.get(key);
      entry?.then(
        (cur) => {
          if (cur === s && this.sessions.get(key) === entry) this.sessions.delete(key);
        },
        () => undefined,
      );
    }
    if (s.input && !s.input.closed) {
      s.input.closed = true;
      try {
        s.input.ws.close();
      } catch {
        // ya cerrado
      }
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

  private touch(s: PooledSession, key: string): void {
    s.lastUsed = this.now();
    this.answered.set(s.host, s.lastUsed);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => this.drop(s, key), this.idleMs);
    s.idleTimer.unref?.();
  }

  private async open(
    host: string,
    clientKey: string,
    deps: TvClientDeps,
    key: string,
  ): Promise<PooledSession> {
    const opened = await openSocketRetrying(
      host,
      deps.factory ?? defaultFactory,
      { allowPlaintext: deps.allowPlaintext ?? false },
      deps,
    );
    const s: PooledSession = { ws: opened.ws, host, closed: false, lastUsed: this.now() };
    const onGone = () => {
      s.closed = true;
      this.drop(s, key);
    };
    try {
      const registeredKey = await register(
        opened.ws,
        clientKey,
        deps.commandTimeoutMs ?? tvCommandTimeoutMs(),
        deps.promptWaitMs ?? PROMPT_WAIT_MS,
      );
      if (registeredKey !== clientKey) {
        if (deps.onNewClientKey) {
          try {
            await deps.onNewClientKey(registeredKey);
          } catch {
            // best-effort, como sin sesión
          }
        }
        s.rekeyed = true;
      }
    } catch (err) {
      opened.ws.close();
      s.closed = true;
      throw err;
    }
    opened.ws.on('close', onGone);
    opened.ws.on('error', onGone);
    return s;
  }

  /** Sesión lista: la guardada si sigue viva, o una nueva. `fresh` = recién abierta. */
  private async acquire(
    host: string,
    clientKey: string,
    deps: TvClientDeps,
  ): Promise<{ s: PooledSession; key: string; fresh: boolean }> {
    const key = this.keyOf(host, clientKey, deps);
    const existing = this.sessions.get(key);
    if (existing) {
      const s = await existing.catch(() => null);
      if (s && !s.closed) {
        if (
          this.now() - s.lastUsed <= this.pingAfterMs ||
          (await stillAlive(s.ws, TV_SESSION_PING_TIMEOUT_MS))
        ) {
          if (!s.closed) return { s, key, fresh: false };
        }
        this.drop(s, key);
      }
      if (this.sessions.get(key) === existing) this.sessions.delete(key);
    }
    const pending = this.open(host, clientKey, deps, key);
    this.sessions.set(key, pending);
    try {
      const s = await pending;
      if (s.rekeyed) this.sessions.delete(key);
      return { s, key, fresh: true };
    } catch (err) {
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
      throw err;
    }
  }

  private finish(s: PooledSession, key: string): void {
    if (s.rekeyed) {
      this.drop(s);
      return;
    }
    this.touch(s, key);
  }

  async request(
    host: string,
    clientKey: string,
    uri: string,
    payload: Record<string, unknown>,
    deps: TvClientDeps,
  ): Promise<Record<string, unknown>> {
    const cmdTimeout = deps.commandTimeoutMs ?? tvCommandTimeoutMs();
    for (let attempt = 0; ; attempt += 1) {
      const { s, key, fresh } = await this.acquire(host, clientKey, deps);
      try {
        const res = await requestOn(s.ws, clientKey, uri, payload, cmdTimeout);
        this.finish(s, key);
        return res;
      } catch (err) {
        // Un rechazo de la tele (returnValue false) deja la sesión sana.
        const cut =
          s.closed ||
          (err instanceof Error &&
            /no respondio|cerro la conexion|No se pudo enviar/.test(err.message));
        if (!cut) {
          this.finish(s, key);
          throw err;
        }
        this.drop(s, key);
        if (!fresh && attempt === 0 && READ_ONLY_URI.test(uri)) continue;
        throw err;
      }
    }
  }

  /** Abre (o reutiliza) el socket de input de la sesión. */
  private async inputFor(
    s: PooledSession,
    key: string,
    host: string,
    clientKey: string,
    deps: TvClientDeps,
  ): Promise<PooledInput> {
    const cur = s.input;
    if (cur && !cur.closed) {
      if (
        this.now() - cur.lastUsed <= this.pingAfterMs ||
        (await stillAlive(cur.ws, TV_SESSION_PING_TIMEOUT_MS))
      ) {
        if (!cur.closed) return cur;
      }
      cur.closed = true;
      try {
        cur.ws.close();
      } catch {
        // ya cerrado
      }
    }
    const res = await requestOn(
      s.ws,
      clientKey,
      'com.webos.service.networkinput/getPointerInputSocket',
      {},
      deps.commandTimeoutMs ?? tvCommandTimeoutMs(),
    );
    const socketUrl = parseTvUrl((res as { socketPath?: unknown }).socketPath, host, [
      'ws:',
      'wss:',
    ]);
    if (!socketUrl) throw new Error('La tele devolvio un socket de input no valido.');
    const { timeoutMs } = tvKeyTimings(deps);
    const openInput: TvInputSocketFactory =
      deps.inputFactory ?? ((url) => new WebSocket(url, { rejectUnauthorized: false }));
    const ws = openInput(socketUrl);
    const input: PooledInput = { ws, closed: false, lastUsed: this.now(), lastKeyAt: 0 };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => fail(new Error('timeout enviando la tecla')), timeoutMs);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.closed = true;
        ws.close();
        reject(err);
      };
      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', () => {
        input.closed = true;
        fail(new Error('no se pudo enviar la tecla'));
      });
      ws.on('close', () => {
        input.closed = true;
        fail(new Error('la tele cerro el socket de input antes de tiempo'));
      });
    });
    s.input = input;
    this.touch(s, key);
    return input;
  }

  async key(host: string, clientKey: string, keyName: string, deps: TvClientDeps): Promise<void> {
    // Misma pausa que una ráfaga (tvKeyGapMs, PA_TV_KEY_GAP_MS), también entre órdenes seguidas.
    const gap =
      deps.keyGapMs !== undefined ? tvKeyGapMs(deps) : (this.keyGapMs ?? tvKeyGapMs(deps));
    for (let attempt = 0; ; attempt += 1) {
      const { s, key } = await this.acquire(host, clientKey, deps);
      let input: PooledInput;
      try {
        input = await this.inputFor(s, key, host, clientKey, deps);
      } catch (err) {
        // Nada enviado todavía: con la sesión cortada se prueba UNA vez en limpio.
        if (s.closed && attempt === 0) continue;
        throw err;
      }
      const wait = input.lastKeyAt + gap - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (input.closed) {
        if (attempt === 0) continue;
        throw new Error('la tele cerro el socket de input antes de tiempo');
      }
      try {
        input.ws.send(`type:button\nname:${keyName}\n\n`);
      } catch {
        // send() que lanza = no salió: se puede reabrir una vez.
        input.closed = true;
        try {
          input.ws.close();
        } catch {
          // ya cerrado
        }
        if (attempt === 0) continue;
        throw new Error('no se pudo enviar la tecla');
      }
      input.lastKeyAt = this.now();
      input.lastUsed = input.lastKeyAt;
      this.finish(s, key);
      return;
    }
  }
}

/** Pool compartido del proceso (daemon y /tv); null si PA_TV_SESSION_IDLE_MS=0. */
let sharedPool: TvSessionPool | null | undefined;
export function sharedTvSessionPool(): TvSessionPool | null {
  if (sharedPool === undefined) {
    const idleMs = tvSessionIdleMs();
    sharedPool = idleMs > 0 ? new TvSessionPool({ idleMs }) : null;
  }
  return sharedPool;
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
  if (deps.pool) return deps.pool.key(safeHost, clientKey, keyName, deps);
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

/** Pausa por defecto entre teclas de una ráfaga: la tele pierde pulsaciones pegadas. */
export const TV_KEY_GAP_MS = 150;

/** Tope de una ráfaga: navegar un menú son decenas de teclas, no cientos. */
export const TV_MAX_KEY_BATCH = 40;

/** Pausa entre teclas de una ráfaga: dep > PA_TV_KEY_GAP_MS > 150 ms, acotada 0-2000. */
export function tvKeyGapMs(deps: Pick<TvClientDeps, 'keyGapMs'> = {}): number {
  const v = deps.keyGapMs;
  if (v !== undefined && Number.isFinite(v)) return Math.min(2_000, Math.max(0, Math.round(v)));
  return envMs('PA_TV_KEY_GAP_MS', TV_KEY_GAP_MS, 0, 2_000);
}

/**
 * Una ráfaga de teclas por UN socket de input. Antes, navegar un menú (buscar
 * un partido en Movistar Plus, una peli en Netflix) abría DOS conexiones por
 * pulsación (SSAP + input) y entre turno y turno del modelo la tele se pasaba
 * segundos quieta: por eso «la noto muy lenta». Ahora la secuencia entera sale
 * por una sola conexión, con una pausa corta entre teclas para que la tele no
 * pierda ninguna.
 *
 * Misma disciplina que tvKey: las teclas se validan TODAS contra la whitelist
 * antes de abrir nada (una ráfaga con una ilegal no toca la tele), el
 * socketPath se exige del mismo host y esquema conocido, y el éxito se
 * reporta solo tras abrir, enviar la última y dar el margen de consumo.
 */
export async function tvKeys(
  host: string,
  clientKey: string,
  names: string[],
  deps: TvClientDeps = {},
): Promise<void> {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('Ráfaga de teclas vacía.');
  }
  if (names.length > TV_MAX_KEY_BATCH) {
    throw new Error(`Ráfaga demasiado larga: ${names.length} teclas (máx ${TV_MAX_KEY_BATCH}).`);
  }
  const keyNames = names.map((n) => String(n).trim().toUpperCase());
  for (const k of keyNames) {
    if (!TV_KEY_NAMES.has(k)) {
      throw new Error(`Tecla no valida: ${sanitizeTvText(k, [clientKey])}`);
    }
  }
  if (keyNames.length === 1) {
    await tvKey(host, clientKey, keyNames[0] as string, deps);
    return;
  }
  const safeHost = assertTvHost(host, deps.allowNonLanHost ?? false);
  if (deps.pool) {
    // Sesión persistente: la ráfaga sale por el socket de input ya abierto,
    // con la misma pausa entre teclas y sin margen de cierre al final.
    for (const k of keyNames) await deps.pool.key(safeHost, clientKey, k, deps);
    return;
  }
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
  const gapMs = tvKeyGapMs(deps);
  const openInput: TvInputSocketFactory =
    deps.inputFactory ?? ((url) => new WebSocket(url, { rejectUnauthorized: false }));
  await new Promise<void>((resolve, reject) => {
    const ws = openInput(socketUrl);
    let settled = false;
    let step: ReturnType<typeof setTimeout> | undefined;
    // El timeout total crece con la ráfaga: 5 s de apertura + pausas + consumo.
    const totalMs = timeoutMs + gapMs * (keyNames.length - 1) + graceMs;
    const timer = setTimeout(() => {
      fail(new Error('timeout enviando la ráfaga de teclas'));
    }, totalMs);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (step) clearTimeout(step);
      ws.close();
      reject(err);
    };
    let i = 0;
    const sendNext = (): void => {
      if (settled) return;
      try {
        ws.send(`type:button\nname:${keyNames[i]}\n\n`);
      } catch {
        fail(new Error('no se pudo enviar la ráfaga de teclas'));
        return;
      }
      i += 1;
      if (i < keyNames.length) {
        step = setTimeout(sendNext, gapMs);
        return;
      }
      // Última enviada: margen de consumo y cierre, como tvKey.
      step = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve();
      }, graceMs);
    };
    ws.on('open', sendNext);
    ws.on('error', () => fail(new Error('no se pudo enviar la ráfaga de teclas')));
    ws.on('close', () => {
      if (!settled) fail(new Error('la tele cerro el socket de input antes de tiempo'));
    });
  });
}

/** Longitud máxima de un texto para el teclado de la tele (buscadores, formularios). */
export const TV_TYPE_TEXT_MAX = 200;

/**
 * Escribe el texto ENTERO en el campo enfocado de la tele (SSAP IME
 * insertText): buscar «ceuta sporting» ya no son 14 pulsaciones sobre el
 * teclado en pantalla, con sus 14 pares de conexiones y sus 14 turnos de
 * modelo. La tele contesta error si no hay un campo de texto activo; ese
 * error llega saneado al agente, que puede abrir el buscador y reintentar.
 * Saltos de línea y controles fuera: una tecla ENTER es action=key.
 */
export async function tvTypeText(
  host: string,
  clientKey: string,
  text: string,
  deps: TvClientDeps = {},
): Promise<void> {
  const clean = String(text).replace(CONTROL_CHARS, '').trim();
  if (!clean) throw new Error('Texto vacío: nada que escribir en la tele.');
  if (clean.length > TV_TYPE_TEXT_MAX) {
    throw new Error(`Texto demasiado largo para la tele (máx ${TV_TYPE_TEXT_MAX} caracteres).`);
  }
  await tvRequest(host, clientKey, 'com.webos.service.ime/insertText', { text: clean }, deps);
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
