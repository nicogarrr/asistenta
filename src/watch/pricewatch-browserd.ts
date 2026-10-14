/**
 * Adaptador de pricewatch al sidecar browserd (Camoufox) con fallback al motor actual.
 *
 * `BROWSER_ENGINE=camoufox` enruta las lecturas publicas de tienda por browserd
 * (huella Firefox real: 8/10 ok en el benchmark anti-bot frente a 3/10 del stack
 * playwright+chromium desde IP de datacenter). Cualquier fallo de transporte con
 * el sidecar degrada al motor actual (playwright) para el resto del ciclo; un
 * bloqueo/challenge HTTP NO cuenta como fallo de transporte (se devuelve 403
 * como siempre y no hay fallback: es el dato que pricewatch espera).
 *
 * Limitacion declarada frente a PublicPriceBrowser: el sidecar navega la pagina
 * completa, sin interception por subrecurso; el `permit` se aplica solo al
 * documento principal.
 */
import { BrowserdClient, BrowserdError } from '../browser/browserd-client.js';
import { isBlockedPage } from './pricewatch.js';
import { usesPublicBrowser } from './pricewatch-browser.js';

export interface PricePageReader {
  read(
    url: string,
    permit: (url: string) => Promise<boolean>,
  ): Promise<{ status: number; html: string }>;
  close(): Promise<void>;
}

export class CamoufoxPriceBrowser implements PricePageReader {
  private readonly client: BrowserdClient;
  constructor(client: BrowserdClient = new BrowserdClient()) {
    this.client = client;
  }
  async read(
    url: string,
    permit: (url: string) => Promise<boolean>,
  ): Promise<{ status: number; html: string }> {
    if (!usesPublicBrowser(url)) return { status: 403, html: '' };
    if (!(await permit(url))) return { status: 403, html: '' };
    const nav = await this.client.goto(url);
    const raw = await this.client.evaluate('document.documentElement.outerHTML');
    const html = typeof raw === 'string' ? raw : '';
    if (isBlockedPage(nav.status, html)) return { status: 403, html: '' };
    return { status: nav.status, html };
  }
  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Motor elegido por flag. Default: el actual (playwright). */
export function browserEngine(env: NodeJS.ProcessEnv = process.env): 'camoufox' | 'playwright' {
  return (env.BROWSER_ENGINE ?? '').trim().toLowerCase() === 'camoufox' ? 'camoufox' : 'playwright';
}

/**
 * Envuelve el motor camoufox con fallback al actual: el primer fallo de
 * transporte con el sidecar (no arrancado, sesion rota, timeout) conmuta al
 * fallback para el resto del ciclo y lo registra una sola vez.
 */
export class FallbackPriceBrowser implements PricePageReader {
  private failed = false;
  private readonly primary: PricePageReader;
  private readonly fallback: PricePageReader;
  private readonly log: (msg: string) => void;
  constructor(
    primary: PricePageReader,
    fallback: PricePageReader,
    log: (msg: string) => void = (m) => console.warn(m),
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.log = log;
  }
  async read(
    url: string,
    permit: (url: string) => Promise<boolean>,
  ): Promise<{ status: number; html: string }> {
    if (this.failed) return this.fallback.read(url, permit);
    try {
      return await this.primary.read(url, permit);
    } catch (err) {
      if (!(err instanceof BrowserdError)) throw err;
      this.failed = true;
      this.log(
        `[pricewatch] browserd no disponible (${err.message}); sigo con el motor playwright`,
      );
      return this.fallback.read(url, permit);
    }
  }
  async close(): Promise<void> {
    await Promise.all([
      this.primary.close().catch(() => undefined),
      this.fallback.close().catch(() => undefined),
    ]);
  }
}

/** Factoria del lector segun BROWSER_ENGINE. `fallback` lo inyecta el caller (PublicPriceBrowser). */
export function createPricePageReader(
  fallback: PricePageReader,
  env: NodeJS.ProcessEnv = process.env,
): PricePageReader {
  if (browserEngine(env) !== 'camoufox') return fallback;
  return new FallbackPriceBrowser(new CamoufoxPriceBrowser(), fallback);
}
