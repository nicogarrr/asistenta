/**
 * Cliente HTTP de Glasshouse: la app de webosbrew que corre EN la tele
 * rooteada y expone una API JSON en :8080 (POST /api/control {action,value},
 * GET /api/stats, /api/apps, /api/caps, /api/privacy). Es la via primaria de
 * control de la tele: sin pairing SSAP, y cubre volumen absoluto, inputs,
 * picture, adblock y privacidad, que SSAP no alcanza.
 *
 * Red: la tele vive en la LAN de casa y en el tailnet. Asistenta corre en la
 * misma LAN, asi que el default es LAN primero y tailnet de fallback - el
 * nodo tailscale de la tele se cae tras cada reinicio y tarda en volver.
 *
 * Reglas de reintento (auditor #104 r1):
 * - Las LECTURAS (GET) son idempotentes: cualquier error de red permite
 *   probar el siguiente endpoint.
 * - Las ESCRITURAS (POST /api/control) NO: solo se prueba el siguiente
 *   endpoint cuando la conexion NUNCA se establecio (ECONNREFUSED y familia
 *   - la accion no pudo llegar a la tele). Un timeout o reset tras el envio
 *   es AMBIGUO (la tele pudo aplicar la accion sin contestar): se para ahi
 *   con GlasshouseAmbiguousError, sin reintento ni failover, para no
 *   duplicar la accion.
 * - Un rechazo (ok:false, 401/403/4xx/5xx) es RESPUESTA de la tele: se
 *   propaga y nunca habilita fallback a otro transporte.
 *
 * Auth: Glasshouse sin token configurado acepta todo; con token, Bearer.
 * El token (si existe) vive en el vault (tv:glasshouseToken). Ningun mensaje
 * de error incluye el cuerpo de la peticion, headers, ni texto del servidor
 * sin sanear: un servidor que reflejara el Bearer no lo filtra a logs.
 *
 * API verificada contra la fuente (rorygallagher2024/glasshouse, server/lib/
 * routes.js + controls.js, 11 oct 2026): POST /api/control exige Content-Type
 * application/json y contesta 200 con {ok, error?} siempre que la peticion
 * esta bien formada; el exito real es el campo ok.
 *
 * Decidido por main bajo preferencias de Nico (cero terminal / secretos
 * fuera de chat).
 */

/** Respuesta de /api/control: Glasshouse siempre contesta 200 con {ok,error?}. */
export interface GlasshouseControlResult {
  ok: boolean;
  error?: string;
  [extra: string]: unknown;
}

export interface GlasshouseClientOptions {
  /** URLs base http://IP:8080, en orden de preferencia (LAN primero). */
  endpoints: string[];
  /** Token Bearer de Glasshouse si el servidor lo tiene configurado. */
  token?: string | null;
  /** Timeout por intento y endpoint (default 4000 ms). */
  timeoutMs?: number;
  /** fetch inyectable en tests. */
  fetchImpl?: typeof fetch;
}

/** IP privada LAN, CGNAT de tailscale (100.64/10) o loopback: nada publico. */
const ALLOWED_HOST =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[789]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)$/;

/**
 * El endpoint se concatena en peticiones HTTP: tiene que ser http://IP:puerto
 * de una red privada, sin credenciales, path, query ni fragmento embebidos.
 */
export function assertGlasshouseEndpoint(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Endpoint Glasshouse no valido: se esperaba http://IP:puerto.');
  }
  if (u.protocol !== 'http:') {
    throw new Error('Endpoint Glasshouse no valido: solo http (API local de la tele).');
  }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('Endpoint Glasshouse no valido: sin credenciales, path, query ni fragmento.');
  }
  if (!ALLOWED_HOST.test(u.hostname)) {
    throw new Error(
      'Endpoint Glasshouse no valido: usa la IP de la tele en LAN o tailnet (nada de hosts publicos).',
    );
  }
  // origin normaliza: http://IP:puerto sin barra final (omite :80 por defecto).
  return u.origin;
}

const ACTION_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

/** Codigos de "la conexion nunca se establecio": la accion NO llego a la tele. */
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

export class GlasshouseError extends Error {}

/**
 * Glasshouse no esta ahi en ningun endpoint (todas las conexiones fallaron
 * ANTES de enviar nada). Es el UNICO error ante el que tiene sentido un
 * fallback de transporte (p.ej. SSAP): la tele no recibio la orden.
 */
export class GlasshouseUnavailableError extends GlasshouseError {}

/**
 * Escritura enviada sin respuesta (timeout/reset tras el envio): la tele pudo
 * aplicar la accion. PROHIBIDO reintentar o cambiar de transporte: duplicaria
 * la orden. El caller informa y deja decidir al usuario.
 */
export class GlasshouseAmbiguousError extends GlasshouseError {}

/** Clasifica un fallo de fetch: connect = nunca llego; ambiguous = pudo llegar. */
function classifyNetworkError(err: unknown): 'connect' | 'ambiguous' {
  const anyErr = err as { name?: string; code?: string; cause?: { code?: string } } | null;
  const code = anyErr?.cause?.code ?? anyErr?.code;
  if (code && CONNECT_FAILURE_CODES.has(code)) return 'connect';
  return 'ambiguous';
}

export class GlasshouseClient {
  private readonly endpoints: string[];
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Indice del ultimo endpoint que respondio: se intenta primero la proxima vez. */
  private sticky = 0;

  constructor(opts: GlasshouseClientOptions) {
    if (!opts.endpoints.length) {
      throw new Error('Glasshouse necesita al menos un endpoint (http://IP:8080).');
    }
    this.endpoints = opts.endpoints.map(assertGlasshouseEndpoint);
    this.token = opts.token?.trim() ? opts.token.trim() : null;
    this.timeoutMs = opts.timeoutMs ?? 4_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Texto del servidor saneado antes de entrar en un error/log: sin el token
   * (un servidor que lo reflejara no lo filtra), sin control chars y corto.
   */
  private sanitize(text: unknown): string {
    let s = String(text ?? '');
    if (this.token) s = s.split(this.token).join('[redacted]');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: justo es lo que se quita
    s = s.replace(/[\u0000-\u001F]/g, '');
    return s.slice(0, 200);
  }

  /**
   * POST /api/control {action, value}. Un ok:false es una RESPUESTA de la
   * tele (accion desconocida, power deshabilitado...): se propaga como error
   * legible, NO se reintenta en otro endpoint ni habilita fallbacks.
   */
  async control(
    action: string,
    value?: string | number | boolean,
  ): Promise<GlasshouseControlResult> {
    if (!ACTION_NAME.test(action)) {
      throw new GlasshouseError(`Accion Glasshouse no valida: ${JSON.stringify(action)}.`);
    }
    const body = JSON.stringify(value === undefined ? { action } : { action, value });
    const res = await this.request('POST', '/api/control', false, body);
    let parsed: GlasshouseControlResult;
    try {
      parsed = JSON.parse(res) as GlasshouseControlResult;
    } catch {
      throw new GlasshouseError('Glasshouse respondio algo que no es JSON.');
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
      throw new GlasshouseError('Respuesta de Glasshouse sin campo ok booleano.');
    }
    if (!parsed.ok) {
      throw new GlasshouseError(
        `La tele rechazo ${action}: ${this.sanitize(parsed.error) || 'sin detalle'}.`,
      );
    }
    return parsed;
  }

  /** GET JSON de un endpoint de lectura (/api/stats, /api/apps, ...). */
  async getJson(path: '/api/stats' | '/api/apps' | '/api/caps' | '/api/privacy'): Promise<unknown> {
    const res = await this.request('GET', path, true);
    try {
      return JSON.parse(res) as unknown;
    } catch {
      throw new GlasshouseError(`Glasshouse ${path}: respuesta no JSON.`);
    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * Una peticion contra los endpoints en orden (sticky primero). Solo se pasa
   * al siguiente endpoint cuando la conexion NO llego a establecerse; en
   * escrituras (idempotent=false), un fallo ambiguo (timeout/reset) para el
   * mundo ahi.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    idempotent: boolean,
    body?: string,
  ): Promise<string> {
    const order = this.endpoints.map((_, i) => (this.sticky + i) % this.endpoints.length);
    const connectFailures: string[] = [];
    for (const idx of order) {
      const base = this.endpoints[idx] as string; // orden derivado de indices validos
      try {
        const res = await this.fetchImpl(`${base}${path}`, {
          method,
          // Content-Type solo en POST: el CSRF guard de Glasshouse exige
          // application/json en /api/control; un GET no lo necesita.
          headers:
            body === undefined
              ? this.headers()
              : { ...this.headers(), 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
        if (!res.ok) {
          // Respuesta HTTP: la tele esta ahi; un 401/403/404/415 lo decide el
          // servidor, no se arregla saltando de endpoint.
          const text = this.sanitize(await res.text());
          throw new GlasshouseError(`Glasshouse HTTP ${res.status} en ${base}: ${text}`);
        }
        this.sticky = idx;
        return await res.text();
      } catch (err) {
        if (err instanceof GlasshouseError) throw err;
        const kind = classifyNetworkError(err);
        if (kind === 'ambiguous' && !idempotent) {
          throw new GlasshouseAmbiguousError(
            `La orden se envio a ${base} pero la tele no confirmo (timeout/corte tras el envio). ` +
              'Pudo haberse aplicado: NO se reintenta automaticamente. Comprueba la tele antes de repetirla.',
          );
        }
        connectFailures.push(base);
      }
    }
    throw new GlasshouseUnavailableError(
      `Glasshouse inalcanzable en todos los endpoints (${connectFailures.join(', ')}). ` +
        'La tele puede estar apagada del todo o fuera de la red.',
    );
  }
}
