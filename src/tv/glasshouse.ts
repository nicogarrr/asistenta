/**
 * Cliente HTTP de Glasshouse: la app de webosbrew que corre EN la tele
 * rooteada y expone una API JSON en :8080 (POST /api/control {action,value},
 * GET /api/stats, /api/apps, /api/caps, /api/privacy). Es la via primaria de
 * control de la tele: sin pairing SSAP, y cubre volumen absoluto, inputs,
 * picture, adblock y privacidad, que SSAP no alcanza.
 *
 * Red: la tele vive en la LAN de casa y en el tailnet. Asistenta corre en la
 * misma LAN, asi que el default es LAN primero y tailnet de fallback - el
 * nodo tailscale de la tele se cae tras cada reinicio y tarda en volver. Se
 * prueba cada endpoint en orden con timeout corto y se recuerda el ultimo
 * que respondio.
 *
 * Auth: Glasshouse sin token configurado acepta todo; con token, Bearer o
 * ?k=. El token (si existe) vive en el vault (tv:glasshouseToken), nunca en
 * config ni en logs.
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

export class GlasshouseError extends Error {}

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
   * POST /api/control {action, value}. Un ok:false es una RESPUESTA de la
   * tele (accion desconocida, power deshabilitado...): se propaga como error
   * legible, NO se reintenta en otro endpoint. Solo un fallo de RED
   * (timeout, connection refused) salta al siguiente endpoint.
   */
  async control(
    action: string,
    value?: string | number | boolean,
  ): Promise<GlasshouseControlResult> {
    if (!ACTION_NAME.test(action)) {
      throw new GlasshouseError(`Accion Glasshouse no valida: ${JSON.stringify(action)}.`);
    }
    const body = JSON.stringify(value === undefined ? { action } : { action, value });
    const res = await this.request('POST', '/api/control', body);
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
      throw new GlasshouseError(`La tele rechazo ${action}: ${parsed.error ?? 'sin detalle'}.`);
    }
    return parsed;
  }

  /** GET JSON de un endpoint de lectura (/api/stats, /api/apps, ...). */
  async getJson(path: '/api/stats' | '/api/apps' | '/api/caps' | '/api/privacy'): Promise<unknown> {
    const res = await this.request('GET', path);
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

  private async request(method: 'GET' | 'POST', path: string, body?: string): Promise<string> {
    const order = this.endpoints.map((_, i) => (this.sticky + i) % this.endpoints.length);
    const networkErrors: string[] = [];
    for (const idx of order) {
      const base = this.endpoints[idx];
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
          const text = (await res.text()).slice(0, 300);
          throw new GlasshouseError(`Glasshouse HTTP ${res.status} en ${base}: ${text}`);
        }
        this.sticky = idx;
        return await res.text();
      } catch (err) {
        if (err instanceof GlasshouseError) throw err;
        networkErrors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new GlasshouseError(
      `Glasshouse inalcanzable en todos los endpoints (${networkErrors.join(' | ')}). ` +
        'La tele puede estar apagada del todo o fuera de la red.',
    );
  }
}
