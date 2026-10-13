/**
 * Cliente HTTP del servidor `hidagent` (esp32-iphone-agent), que corre en un
 * equipo de la MISMA red que el iPhone: recibe la pantalla por AirPlay (UxPlay)
 * y toca el telefono a traves de una ESP32-S3 conectada por USB.
 *
 * Solo habla con la API local del servidor. No sabe nada del modelo de vision:
 * el servidor lleva su propio planificador/actor (ver deploy/iphone/).
 */

export interface IphoneStatus {
  /** La ESP32 esta conectada al servidor (puerto 7300). */
  device: boolean;
  /** Hay una pantalla en directo (el iPhone esta duplicando por AirPlay). */
  screen: boolean;
  /** El puntero esta calibrado. */
  calibrated: boolean;
  models: { planner: string; actor: string };
  agent: { running: boolean; task: string | null; steps: number };
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export class IphoneError extends Error {}

export interface IphoneClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Acepta solo http(s) y quita la barra final. Falla en la llamada, no al arrancar. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new IphoneError(`URL del servidor del iPhone no valida: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IphoneError('La URL del servidor del iPhone debe ser http(s).');
  }
  return url.origin;
}

export class IphoneClient {
  private readonly base: string;
  private readonly f: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: IphoneClientOptions) {
    this.base = normalizeBaseUrl(opts.baseUrl);
    this.f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async call(path: string, method: 'GET' | 'POST', body?: unknown) {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new IphoneError(
        `No llego al servidor del iPhone (${this.base}): ${err instanceof Error ? err.message : String(err)}. ` +
          'Comprueba que esta arrancado y en la misma red que el telefono.',
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new IphoneError(
        `El servidor del iPhone respondio ${res.status}: ${detail.slice(0, 300)}`,
      );
    }
    return res;
  }

  async status(): Promise<IphoneStatus> {
    const raw = (await (await this.call('/api/status', 'GET')).json()) as Record<string, unknown>;
    const models = (raw.models ?? {}) as Record<string, unknown>;
    const agent = (raw.agent ?? {}) as Record<string, unknown>;
    return {
      device: raw.device === true,
      screen: raw.screen === true,
      calibrated: raw.calibrated === true,
      models: { planner: String(models.planner ?? ''), actor: String(models.actor ?? '') },
      agent: {
        running: agent.running === true,
        task: typeof agent.task === 'string' ? agent.task : null,
        steps: typeof agent.steps === 'number' ? agent.steps : 0,
      },
    };
  }

  /** Frame JPEG actual del telefono. Lanza si no hay pantalla en directo. */
  async frame(): Promise<Buffer> {
    const res = await this.call('/api/frame.jpg', 'GET');
    return Buffer.from(await res.arrayBuffer());
  }

  async start(goal: string): Promise<void> {
    await this.call('/api/agent', 'POST', { text: goal });
  }

  async stop(): Promise<void> {
    await this.call('/api/agent/stop', 'POST', {});
  }

  async home(): Promise<void> {
    await this.call('/api/home', 'POST', {});
  }
}

/** Que falta para poder actuar. Vacio = listo. */
export function readiness(s: IphoneStatus): string[] {
  const missing: string[] = [];
  if (!s.device)
    missing.push(
      'la ESP32 no esta conectada al servidor (enchufala al iPhone y comprueba el wifi)',
    );
  if (!s.screen)
    missing.push(
      'el iPhone no esta duplicando la pantalla (Centro de control > Duplicar pantalla > "iPhone Agent")',
    );
  if (!s.calibrated)
    missing.push('el puntero no esta calibrado (interfaz web > Manual controls > Calibrate)');
  return missing;
}
