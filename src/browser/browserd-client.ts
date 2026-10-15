/**
 * Cliente HTTP minimo para browserd (sidecar Camoufox, PR #129).
 * Sin dependencias nuevas: fetch nativo de Node 20+.
 *
 * Taxonomia de errores (auditoria #130):
 * - BrowserdError SOLO envuelve fallos de TRANSPORTE (conexion rechazada,
 *   DNS, socket, timeout end-to-end). Es el unico disparador de fallback.
 * - BrowserdHttpError: respuesta HTTP no-2xx DEL sidecar (esta vivo: 401 del
 *   guard, 422 de validacion, 502 de navegacion). NUNCA dispara fallback.
 * - Cualquier otro error (bugs de programacion) propaga intacto.
 *
 * Defensas heredadas del sidecar: el token SOLO sale hacia BROWSERD_URL
 * (loopback por defecto); nunca se registra en logs.
 */
export interface BrowserdOptions {
  baseUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
  /** Timeout HTTP end-to-end por llamada (defecto 45s): un sidecar colgado corta y cuenta como transporte. */
  timeoutMs?: number;
}

/** Fallo de TRANSPORTE con el sidecar. Unico disparador de fallback. */
export class BrowserdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserdError';
  }
}

/** Respuesta HTTP no-2xx DEL sidecar: el sidecar esta vivo, no hay fallback. */
export class BrowserdHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'BrowserdHttpError';
    this.status = status;
  }
}

/** undici lanza TypeError("fetch failed") con `cause` codificada para errores de red; un TypeError de programacion no tiene cause de red. */
function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    err instanceof TypeError &&
    cause instanceof Error &&
    typeof (cause as { code?: unknown }).code === 'string'
  );
}

export class BrowserdClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;

  constructor(opts: BrowserdOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.BROWSERD_URL ?? 'http://127.0.0.1:7701').replace(
      /\/+$/,
      '',
    );
    this.token = opts.token ?? process.env.BROWSERD_TOKEN ?? '';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // fetch Y lectura del cuerpo dentro del mismo manejo: un cuelgue a mitad
    // del JSON tambien corta por AbortSignal y cuenta como transporte (#130).
    // Un JSON invalido (SyntaxError) es bug/protocolo y propaga sin envolver.
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok)
        throw new BrowserdHttpError(`browserd ${method} ${path}: HTTP ${res.status}`, res.status);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof BrowserdHttpError) throw err;
      if (isTransportError(err))
        throw new BrowserdError(`browserd inalcanzable: ${(err as Error).message}`);
      throw err;
    }
  }

  async health(): Promise<{ ok?: boolean; sessions?: number }> {
    return this.call('GET', '/health');
  }

  /** Crea o reusa la sesion persistente del scope (perfil con cookies por scope). */
  async ensureSession(scope: string): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const r = await this.call<{ id: string }>('POST', '/sessions', { scope });
    this.sessionId = r.id;
    return r.id;
  }

  async goto(
    url: string,
    opts: {
      waitUntil?: string;
      timeoutMs?: number;
      settleMs?: number;
      /** Barrera por request en el sidecar: host cubierto por alguno de estos dominios. */
      allowedHosts?: string[];
      /** Hook loopback del cliente: 2xx permite la request, cualquier otra cosa la niega (fail-closed). */
      permitUrl?: string;
    } = {},
  ): Promise<{ status: number; url: string; title: string; denied?: boolean }> {
    const id = await this.ensureSession('pricewatch');
    return this.call('POST', `/sessions/${id}/goto`, {
      url,
      wait_until: opts.waitUntil ?? 'domcontentloaded',
      timeout_ms: opts.timeoutMs ?? 30_000,
      settle_ms: opts.settleMs ?? 3_000,
      ...(opts.allowedHosts ? { allowed_hosts: opts.allowedHosts } : {}),
      ...(opts.permitUrl ? { permit_url: opts.permitUrl } : {}),
    });
  }

  /** Lectura atomica: goto + evaluate + cierre de pagina en el sidecar (sin pagina viva entre lecturas). */
  async readPage(
    url: string,
    opts: {
      expression: string;
      waitUntil?: string;
      timeoutMs?: number;
      settleMs?: number;
      allowedHosts?: string[];
      permitUrl?: string;
    },
  ): Promise<{ status: number; url: string; title: string; value: unknown; denied?: boolean }> {
    const id = await this.ensureSession('pricewatch');
    return this.call('POST', `/sessions/${id}/read`, {
      url,
      expression: opts.expression,
      wait_until: opts.waitUntil ?? 'domcontentloaded',
      timeout_ms: opts.timeoutMs ?? 30_000,
      settle_ms: opts.settleMs ?? 3_000,
      ...(opts.allowedHosts ? { allowed_hosts: opts.allowedHosts } : {}),
      ...(opts.permitUrl ? { permit_url: opts.permitUrl } : {}),
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const id = await this.ensureSession('pricewatch');
    const r = await this.call<{ value: unknown }>('POST', `/sessions/${id}/evaluate`, {
      expression,
    });
    return r.value;
  }

  /** Si la sesion murio (reinicio del sidecar), la proxima llamada crea una nueva. */
  resetSession(): void {
    this.sessionId = null;
  }

  async close(): Promise<void> {
    const id = this.sessionId;
    this.sessionId = null;
    if (!id) return;
    await this.call('DELETE', `/sessions/${id}`).catch(() => undefined);
  }
}
