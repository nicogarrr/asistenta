/**
 * Cliente HTTP minimo para browserd (sidecar Camoufox, PR #129).
 * Sin dependencias nuevas: fetch nativo de Node 20+.
 *
 * Defensas heredadas del sidecar: el token SOLO sale hacia BROWSERD_URL
 * (loopback por defecto); nunca se registra en logs.
 */
export interface BrowserdOptions {
  baseUrl?: string;
  token?: string;
  fetchFn?: typeof fetch;
}

export class BrowserdError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'BrowserdError';
    this.status = status;
  }
}

export class BrowserdClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private sessionId: string | null = null;

  constructor(opts: BrowserdOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.BROWSERD_URL ?? 'http://127.0.0.1:7701').replace(
      /\/+$/,
      '',
    );
    this.token = opts.token ?? process.env.BROWSERD_TOKEN ?? '';
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new BrowserdError(`browserd inalcanzable: ${(err as Error).message}`);
    }
    if (!res.ok)
      throw new BrowserdError(`browserd ${method} ${path}: HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
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
    opts: { waitUntil?: string; timeoutMs?: number; settleMs?: number } = {},
  ): Promise<{ status: number; url: string; title: string }> {
    const id = await this.ensureSession('pricewatch');
    return this.call('POST', `/sessions/${id}/goto`, {
      url,
      wait_until: opts.waitUntil ?? 'domcontentloaded',
      timeout_ms: opts.timeoutMs ?? 30_000,
      settle_ms: opts.settleMs ?? 3_000,
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
