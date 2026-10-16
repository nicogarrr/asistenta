/**
 * Listener HTTP :8765 para el boton del mando (magic_mapper).
 *
 * Que es: el boton del mando, mapeado en la tele, hace `curl` contra este
 * listener. Es lo unico que hay entre apretar un boton y que Asistenta se
 * despierte, asi que la superficie es minima a proposito: dos rutas, sin
 * parametros, sin estado y sin secretos de vuelta.
 *
 * Por que existe: `scripts/tv/install-magic-mapper.sh` ABORTA antes de tocar
 * la tele si `GET /tv/button-health` no responde (linea 41-42). Ese preflight
 * es fail-closed y esta bien que lo sea: desplegar el mapper sin listener
 * deja un boton que no hace nada y un rollback que ya no falta. Esta
 * implementacion es la pieza que faltaba para que ese preflight pueda pasar.
 *
 * Red: superficie de red nueva en la LAN, asi que binds explicito a una
 * interfaz privada (nunca 0.0.0.0 por defecto) y rechaza peticiones que no
 * vengan de un rango privado. El instalador solo genera URLs
 * `http://<ip-laptop-privada>:8765/...`, que es justo lo que se acepta.
 *
 * Auth: secreto compartido opcional desde el vault (`tv:buttonToken`), con
 * la misma postura que Glasshouse - si no hay token configurado, acepta todo.
 * Con token, `/tv/button` NO acepta un Bearer: el listener es HTTP plano en la
 * LAN y un Bearer viajaria en claro en cada pulsacion. En su lugar la tele
 * firma cada pulsacion con HMAC-SHA256 sobre `ts.nonce.METODO.ruta`
 * (cabeceras X-TV-Ts / X-TV-Nonce / X-TV-Sig, ninguna secreta): el token no
 * viaja NUNCA por la red, una firma vale solo para su metodo y ruta, caduca
 * a los +-5 minutos (desfase de reloj de la tele) y la cache de firmas vistas
 * rechaza replays dentro de la ventana. Lo unico observable por un tercero en
 * la LAN es "alguien pulso el boton", que no es un secreto.
 * `/tv/button-health` sigue abierto a proposito: el preflight del instalador
 * lo llama sin credenciales, y un probe de vida no tiene por que revelar nada
 * mas que "hay alguien escuchando".
 *
 * Que NO hace: no acepta texto, ni instrucciones, ni canal. El boton no es una
 * via de entrada para el agente, es un interruptor. Todo lo que llega por aqui
 * pasa por `onButton`, que reutiliza el camino de la palabra de activacion con
 * la peticion vacia - el mismo codigo que ya aplica allowlist, gate y voz.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { log } from '../log.js';

/** Puerto que exige `install-magic-mapper.sh` en su preflight. */
export const TV_BUTTON_PORT = 8765;

/** Ruta de preflight: la que el instalador exige antes de desplegar. */
export const TV_BUTTON_HEALTH_PATH = '/tv/button-health';

/** Ruta del boton: la que magic_mapper tiene en su config (`__ASISTENTA_URL__`). */
export const TV_BUTTON_PATH = '/tv/button';

/**
 * Solo IPs privadas de LAN o CGNAT de tailscale, o loopback. Nada publico:
 * un listener que despierta un agente con control total no debe ser alcanzable
 * desde internet, ni por error de bind ni por una IP tailscale reenviada.
 *
 * Se prueba como predicado y no como regex gigante porque el error de este
 * patron es silencioso y facil de repetir: un octeto de mas en una alternativa
 * rechaza IPs privadas de verdad sin que nada falle visible. Con una funcion,
 * `isPrivateRemote('192.168.1.237')` se puede comprobar en un test.
 */
const PRIVATE_V4 =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/** IPv4 privado (LAN o CGNAT 100.64/10) o loopback, en cualquiera de sus formas. */
export function isPrivateRemote(ip: string): boolean {
  const raw = ip.trim();
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') return true;
  // Node entrega las conexiones IPv4 mapeadas como `::ffff:a.b.c.d`.
  const v4 = raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
  return PRIVATE_V4.test(v4);
}

/** IP sin puerto ni corchetes IPv6, para comparar contra la allowlist. */
function remoteAddress(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? '';
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

/**
 * Ventana de validez de una firma: la tele y el laptop no comparten NTP
 * garantizado, asi que se tolera un desfase de reloj razonable y NADA mas.
 * Dentro de la ventana, la cache de firmas vistas es la que impide el replay.
 */
export const TV_BUTTON_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

interface ButtonSignature {
  ts: string;
  nonce: string;
  sig: string;
}

/** Lee y valida la FORMA de las cabeceras de firma (sin comprobar el HMAC). */
function readSignature(req: IncomingMessage): ButtonSignature | null {
  const ts = req.headers['x-tv-ts'];
  const nonce = req.headers['x-tv-nonce'];
  const sig = req.headers['x-tv-sig'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') return null;
  if (!/^\d{9,13}$/.test(ts)) return null;
  if (!/^[0-9a-f]{8,64}$/.test(nonce)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  return { ts, nonce, sig };
}

/** Mensaje canonico firmado por la tele: `ts.nonce.METODO.ruta` (ruta normalizada). */
export function tvButtonMessage(ts: string, nonce: string, method: string, path: string): string {
  return `${ts}.${nonce}.${method}.${path}`;
}

/**
 * HMAC-SHA256 de una pulsacion. Exportado para que el parche de magic_mapper
 * y los tests firmen EXACTAMENTE el mismo mensaje que se verifica aqui.
 */
export function signTvButton(
  secret: string,
  ts: string,
  nonce: string,
  method: string,
  path: string,
): string {
  return createHmac('sha256', secret)
    .update(tvButtonMessage(ts, nonce, method, path))
    .digest('hex');
}

export interface TvButtonListenerOptions {
  /** Puerto de escucha. */
  port?: number;
  /**
   * Interfaz a la que se hace bind. Por defecto todas las interfaces, porque
   * el instalador alcanza este puerto desde la IP LAN del laptop, que no es
   * necesariamente 127.0.0.1. La allowlist de `remoteAddress` es la que impide
   * que una peticion de fuera entre.
   */
  host?: string;
  /** Secreto HMAC desde el vault. Sin token, `/tv/button` acepta cualquiera. */
  token?: string | null;
  /** What to run when the button is pressed. */
  onButton: (source: string) => Promise<void> | void;
}

export interface TvButtonListener {
  server: Server;
  /**
   * Puerto realmente escuchando. Getter y no copia porque `port: 0` deja que
   * el SO elija, y el puerto asignado solo existe despues del listen: copiarlo
   * devolveria el 0 pedido en vez del puerto de verdad.
   */
  readonly port: number;
  /** Resolves when actually listening (not merely created). */
  ready: Promise<void>;
  close: () => Promise<void>;
}

/**
 * Arranca el listener. No tira si el puerto esta ocupado: devuelve `ready`
 * rechazado y el llamador decide, porque un daemon sin listener del boton
 * sigue siendo un daemon perfectamente valido.
 */
export function startTvButtonListener(opts: TvButtonListenerOptions): TvButtonListener {
  const port = opts.port ?? TV_BUTTON_PORT;
  const host = opts.host ?? '0.0.0.0';
  const token = opts.token?.trim() || null;
  // Firmas ya aceptadas -> instante en que DEJAN de ser validas (tsMs +
  // WINDOW). No basta guardar el instante de aceptacion: una firma con ts
  // hasta WINDOW en el futuro sigue siendo valida hasta WINDOW despues de
  // podarse la entrada, y ahi entraria el replay. Como el ts aceptado esta a
  // lo sumo WINDOW en el futuro, cada entrada vive < 2 * WINDOW y el mapa
  // esta acotado. Se poda en cada verificacion.
  const seenSignatures = new Map<string, number>();

  /** Verifica ventana de reloj, HMAC en tiempo constante y anti-replay. */
  const signatureValid = (
    method: string,
    path: string,
    presented: ButtonSignature | null,
  ): boolean => {
    if (!token || presented === null) return false;
    const tsMs = Number(presented.ts) * 1000;
    const now = Date.now();
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > TV_BUTTON_SIGNATURE_WINDOW_MS)
      return false;
    const expected = Buffer.from(signTvButton(token, presented.ts, presented.nonce, method, path));
    const got = Buffer.from(presented.sig);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
    // Poda coherente con la ventana de aceptacion: la firma es valida con
    // |now - ts| <= WINDOW (se rechaza solo >), asi que la entrada debe
    // sobrevivir TAMBIEN en el milisegundo exacto tsMs+WINDOW; podar con >=
    // reabriria el replay justo en ese milisegundo.
    for (const [sig, expiresAt] of seenSignatures) if (now > expiresAt) seenSignatures.delete(sig);
    if (seenSignatures.has(presented.sig)) return false; // replay dentro de la ventana
    seenSignatures.set(presented.sig, tsMs + TV_BUTTON_SIGNATURE_WINDOW_MS);
    return true;
  };

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      // El boton no necesita CORS ni cookies: nada de eso se usa aqui, y
      // permitirlo abriria el listener a paginas web arbitrarias del navegador.
      'cache-control': 'no-store',
    });
    res.end(payload);
  };

  const server = createServer((req, res) => {
    const boundPort = (): number => {
      const address = server.address();
      return address && typeof address === 'object' ? address.port : port;
    };

    const remote = remoteAddress(req);
    if (!isPrivateRemote(remote)) {
      log.warn('tv button: peticion desde origen no permitido', { remote });
      send(res, 403, { ok: false, error: 'origen no permitido' });
      return;
    }

    // El path sin query ni trailing slash: el instalador genera la URL exacta.
    const path = req.url?.split('?')[0]?.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === TV_BUTTON_HEALTH_PATH) {
      if (method !== 'GET' && method !== 'HEAD') {
        send(res, 405, { ok: false, error: 'metodo no permitido' });
        return;
      }
      // Preflight del instalador. A proposito sin token y sin informacion: solo
      // confirma que hay alguien escuchando, no quien ni con que estado.
      send(res, 200, { ok: true, service: 'tv-button', port: boundPort() });
      return;
    }

    if (path === TV_BUTTON_PATH) {
      // magic_mapper ejecuta `curl` con solo una URL, que es GET. Aceptar solo
      // POST dejaria el boton deployed y muerto: el boton tiene que funcionar
      // con la invocacion que el mapper hace de verdad.
      if (method !== 'GET' && method !== 'POST') {
        send(res, 405, { ok: false, error: 'metodo no permitido' });
        return;
      }
      if (token && !signatureValid(method, path, readSignature(req))) {
        log.warn('tv button: peticion sin firma valida', { remote, path });
        send(res, 401, { ok: false, error: 'no autorizado' });
        return;
      }
      // No se espera laturno: apretar el boton no debe bloquear al mando, y el
      // turno se habla por el canal de voz, no por esta respuesta.
      send(res, 202, { ok: true });
      void Promise.resolve(opts.onButton(remote)).catch((err: unknown) =>
        log.error('tv button: fallo disparando el boton', { err }),
      );
      return;
    }

    send(res, 404, { ok: false, error: 'no encontrado' });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  // Si el llamador ignora `ready`, un fallo de listen no debe explotar como
  // unhandledRejection.
  void ready.catch(() => undefined);
  server.listen(port, host);

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      // keep-alive mantiene sockets vivos y `close` solo no bastaria para
      // liberar el puerto antes de que el proceso muera.
      server.closeAllConnections?.();
    });

  return {
    server,
    get port(): number {
      const address = server.address();
      if (address && typeof address === 'object') return address.port;
      // Antes del listen no hay puerto real que leer; el pedido es lo unico
      // honesto que se puede devolver.
      return port;
    },
    ready,
    close,
  };
}
