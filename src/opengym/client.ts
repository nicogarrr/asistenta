/**
 * Cliente de SOLO LECTURA para openGym (tracker de gimnasio self-hosted de Nico).
 *
 * Qué hace: pedir su documento de estado (GET /api/data), renovar el token cuando toca
 * (GET /api/me) y canjear un código de emparejamiento (POST /api/pair/redeem).
 * Qué NO hace, a propósito: ningún PUT/POST de datos. La escritura es otra fase.
 *
 * Seguridad:
 * - La URL sale de la configuración de Nico (PA_OPENGYM_URL, vault o argumento de `pa opengym pair`),
 *   nunca del modelo ni de un enlace pegado en el chat, y parseBaseUrl la valida. Por eso NO pasa por el control SSRF de la tool fetch: la VM vive en la tailnet
 *   (100.64.0.0/10), que ese control bloquea con razón para URLs arbitrarias.
 * - El token solo viaja a esa URL: `redirect: 'error'` impide que un redirect lo reenvíe.
 * - El token nunca entra en un mensaje de error ni en el log.
 */

export class OpenGymError extends Error {
  readonly kind: 'config' | 'auth' | 'network' | 'server';
  constructor(kind: OpenGymError['kind'], message: string) {
    super(message);
    this.name = 'OpenGymError';
    this.kind = kind;
  }
}

export interface GymState {
  [key: string]: unknown;
}

export interface OpenGymClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | undefined>;
  setToken: (token: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Cada cuánto se pregunta a /api/me por un token renovado (el servidor solo lo da pasada la mitad de su vida). */
const REFRESH_CHECK_MS = 12 * 3_600_000;

/**
 * Normaliza y valida la URL base. https siempre; http solo para localhost, IPs de la
 * tailnet (100.64/10) o nombres *.ts.net, donde el tráfico ya va cifrado por WireGuard.
 */
export function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OpenGymError('config', 'la URL de openGym no es válida');
  }
  const host = url.hostname.toLowerCase();
  const tailnetIp = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host);
  const plainOk =
    host === 'localhost' || host === '127.0.0.1' || host.endsWith('.ts.net') || tailnetIp;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && plainOk)) {
    throw new OpenGymError(
      'config',
      'la URL de openGym debe ser https (http solo para la tailnet o localhost)',
    );
  }
  if (url.username || url.password) {
    throw new OpenGymError('config', 'la URL de openGym no debe llevar usuario ni contraseña');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function networkMessage(err: unknown): string {
  const text =
    err instanceof Error
      ? `${err.name} ${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
      : String(err);
  if (/abort|timeout|timed out/i.test(text)) {
    return 'openGym no responde (tiempo agotado). ¿Está Tailscale encendido en el PC y la VM en marcha?';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return 'no encuentro el nombre de openGym. ¿Está Tailscale encendido en el PC (con MagicDNS)?';
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(text)) {
    return 'no consigo conectar con openGym. ¿Está Tailscale encendido en el PC y la VM en marcha?';
  }
  if (/certificate|CERT_|SSL|TLS/i.test(text)) {
    return 'el certificado de openGym no es válido desde este PC';
  }
  return 'no he podido hablar con openGym (fallo de red)';
}

/** URL absoluta de una ruta de la API; `new URL` deja "/" como ruta vacía, así que se quita aquí. */
function apiUrl(base: URL, path: string): string {
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  return `${base.origin}${prefix}${path}`;
}

export class OpenGymClient {
  private readonly base: URL;
  private readonly opts: OpenGymClientOptions;
  private readonly fetchImpl: typeof fetch;
  private lastRefreshCheck = 0;

  constructor(opts: OpenGymClientOptions) {
    this.opts = opts;
    this.base = parseBaseUrl(opts.baseUrl);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(path: string, token: string): Promise<Response> {
    const url = apiUrl(this.base, path);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (err) {
      throw new OpenGymError('network', networkMessage(err));
    }
  }

  private async requireToken(): Promise<string> {
    const token = (await this.opts.getToken())?.trim();
    if (!token) {
      throw new OpenGymError('config', 'openGym no está emparejado todavía (falta el token)');
    }
    return token;
  }

  private static async json(res: Response): Promise<unknown> {
    if (res.status === 401) {
      throw new OpenGymError(
        'auth',
        'el token de openGym ha caducado o no es válido; hay que emparejar de nuevo (Ajustes > emparejar la app móvil)',
      );
    }
    if (!res.ok) throw new OpenGymError('server', `openGym respondió con error ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new OpenGymError('server', 'openGym devolvió una respuesta que no entiendo');
    }
  }

  /** Renueva el token si el servidor lo ofrece. Un fallo aquí no impide leer datos. */
  async refreshTokenIfDue(): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.lastRefreshCheck < REFRESH_CHECK_MS) return;
    const token = await this.requireToken();
    try {
      const body = (await OpenGymClient.json(await this.call('/api/me', token))) as {
        token?: unknown;
      };
      this.lastRefreshCheck = now;
      if (typeof body.token === 'string' && body.token.length > 20) {
        await this.opts.setToken(body.token);
      }
    } catch (err) {
      // Un 401 sí es información útil: se deja pasar. El resto no bloquea la lectura.
      if (err instanceof OpenGymError && err.kind === 'auth') throw err;
    }
  }

  /** El documento completo del usuario. `state` es null si aún no ha sincronizado nada. */
  async getState(): Promise<{ state: GymState | null; rev: number }> {
    await this.refreshTokenIfDue();
    const token = await this.requireToken();
    const body = (await OpenGymClient.json(await this.call('/api/data', token))) as {
      state?: unknown;
      rev?: unknown;
    };
    const state =
      body.state && typeof body.state === 'object' && !Array.isArray(body.state)
        ? (body.state as GymState)
        : null;
    return { state, rev: typeof body.rev === 'number' ? body.rev : 0 };
  }
}

/** Canjea un código de emparejamiento (8 caracteres, un solo uso, 5 min) por un token de sesión. */
export async function redeemPairingCode(
  baseUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const base = parseBaseUrl(baseUrl);
  const clean = code.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(clean)) {
    throw new OpenGymError(
      'config',
      'el código de emparejamiento son 8 letras y números (sin 0, O, 1, I)',
    );
  }
  let res: Response;
  try {
    res = await fetchImpl(apiUrl(base, '/api/pair/redeem'), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code: clean }),
    });
  } catch (err) {
    throw new OpenGymError('network', networkMessage(err));
  }
  if (res.status === 400) {
    throw new OpenGymError(
      'auth',
      'openGym no acepta ese código: está caducado, ya se usó o es incorrecto. Genera uno nuevo',
    );
  }
  if (!res.ok) throw new OpenGymError('server', `openGym respondió con error ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== 'string' || body.token.length < 20) {
    throw new OpenGymError('server', 'openGym no devolvió un token');
  }
  return body.token;
}
