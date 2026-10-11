/**
 * Cliente SSAP minimo para LG webOS TV: pairing PROMPT una vez (la tele
 * muestra un aviso y hay que aceptarlo con el mando) y requests con la
 * client-key resultante. Protocolo verificado contra bscpylgtv
 * (webos_client.py + endpoints.py): wss://IP:3001 con cert autofirmado
 * (rejectUnauthorized: false), fallback ws://IP:3000.
 *
 * La client-key NO caduca con el modo developer: vive hasta que la tele
 * restablezca ajustes o revoque el dispositivo. Se guarda en el vault local
 * (tv:host, tv:clientKey) desde el CLI.
 */

import WebSocket from 'ws';
import { TV_MANIFEST } from './manifest.js';

/** Primer pairing: hay que aceptar el aviso en la tele con el mando. */
const PAIR_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CMD_TIMEOUT_MS = 10_000;

/** Subconjunto de ws que usa el cliente (inyectable en tests). */
export interface TvSocket {
  once(event: 'open' | 'error', cb: (...args: unknown[]) => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export type TvSocketFactory = (url: string) => TvSocket;

const defaultFactory: TvSocketFactory = (url) =>
  // La tele usa cert autofirmado: sin rejectUnauthorized el handshake TLS
  // falla. Alcance: solo esta conexion LAN; no relaja TLS de nada mas.
  new WebSocket(url, { rejectUnauthorized: false });

async function openSocket(host: string, factory: TvSocketFactory): Promise<TvSocket> {
  let lastError: unknown;
  for (const url of [`wss://${host}:3001`, `ws://${host}:3000`]) {
    try {
      const ws = factory(url);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout abriendo ${url}`)),
          CONNECT_TIMEOUT_MS,
        );
        ws.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return ws;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `No se pudo conectar con la TV en ${host} (wss://3001 y ws://3000). ` +
      `¿Encendida y en la misma red? (${lastError instanceof Error ? lastError.message : String(lastError)})`,
  );
}

interface SsapMessage {
  type?: string;
  id?: string;
  error?: string;
  payload?: Record<string, unknown> & { 'client-key'?: string };
}

/**
 * Registro SSAP. Sin client-key (pairingType PROMPT) la tele muestra un
 * aviso hasta que alguien lo acepta con el mando; con client-key previa el
 * registro es inmediato y sin aviso. El primer mensaje 'response' (eco del
 * pairingType) solo indica que el aviso esta en pantalla: se espera.
 */
function register(ws: TvSocket, clientKey: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          clientKey
            ? `La TV no respondio al registro en ${timeoutMs / 1000}s.`
            : `La TV no respondio en ${timeoutMs / 1000}s: en el primer emparejamiento hay que ACEPTAR el aviso que sale en la tele con el mando.`,
        ),
      );
    }, timeoutMs);
    ws.on('message', (data) => {
      let msg: SsapMessage;
      try {
        msg = JSON.parse(String(data)) as SsapMessage;
      } catch {
        return;
      }
      if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(`La TV rechazo el registro: ${msg.error ?? 'error desconocido'}`));
        return;
      }
      if (msg.type === 'registered' && msg.payload?.['client-key']) {
        clearTimeout(timer);
        resolve(msg.payload['client-key']);
      }
    });
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
    );
  });
}

export interface TvClientDeps {
  factory?: TvSocketFactory;
  pairTimeoutMs?: number;
  commandTimeoutMs?: number;
}

/** Emparejamiento PROMPT: devuelve la client-key que hay que persistir. */
export async function pairTv(host: string, deps: TvClientDeps = {}): Promise<string> {
  const ws = await openSocket(host, deps.factory ?? defaultFactory);
  try {
    return await register(ws, undefined, deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS);
  } finally {
    ws.close();
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
  const ws = await openSocket(host, deps.factory ?? defaultFactory);
  const cmdTimeout = deps.commandTimeoutMs ?? CMD_TIMEOUT_MS;
  try {
    await register(ws, clientKey, cmdTimeout);
    return await new Promise((resolve, reject) => {
      const id = `cmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const timer = setTimeout(
        () => reject(new Error(`La TV no respondio a ${uri} en ${cmdTimeout / 1000}s.`)),
        cmdTimeout,
      );
      ws.on('message', (data) => {
        let msg: SsapMessage;
        try {
          msg = JSON.parse(String(data)) as SsapMessage;
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(timer);
        if (msg.type === 'response') {
          resolve(msg.payload ?? {});
        } else {
          reject(
            new Error(`La TV devolvio error en ${uri}: ${msg.error ?? msg.type ?? 'desconocido'}`),
          );
        }
      });
      ws.send(JSON.stringify({ type: 'request', id, uri: `ssap://${uri}`, payload }));
    });
  } finally {
    ws.close();
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
