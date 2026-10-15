/**
 * Adaptador de pricewatch al sidecar browserd (Camoufox) con fallback al motor actual.
 *
 * `BROWSER_ENGINE=camoufox` enruta las lecturas publicas de tienda por browserd
 * (huella Firefox real: 8/10 ok en el benchmark anti-bot frente a 3/10 del stack
 * playwright+chromium desde IP de datacenter). Solo un fallo de TRANSPORTE con
 * el sidecar (no arrancado, timeout HTTP, socket) conmuta al motor actual para
 * el resto del ciclo; una respuesta HTTP del sidecar (401/422/502) o un 403 de
 * bloqueo/challenge NO disparan fallback.
 *
 * Barrera por request (auditoria #130): la navegacion lleva `allowed_hosts`
 * (tiendas de la allowlist) y `permit_url` (hook loopback servido AQUI que
 * consulta el mismo `permit` robots+presupuesto del motor historico); el
 * sidecar corta TODA request que no la pase, subrecursos incluidos, y los
 * documentos van de un salto (cada redirect re-entra por la barrera). El hook
 * es fail-closed: si este proceso no responde, la request se deniega.
 *
 * Estado: el sidecar usa perfil persistente por scope (cookies conservadas
 * entre ciclos), a diferencia del lector historico sin estado. Es deliberado:
 * los numeros del benchmark (8/10) se midieron con perfil persistente y la
 * huella estable es parte del valor anti-bot; robots/presupuesto no dependen
 * del estado de cookies.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserdClient, BrowserdError, BrowserdHttpError } from '../browser/browserd-client.js';
import { isBlockedPage, STORES } from './pricewatch.js';
import { usesPublicBrowser } from './pricewatch-browser.js';

/** Dominios de tienda de la allowlist publica (misma fuente que usesPublicBrowser). */
export const PUBLIC_STORE_HOSTS: readonly string[] = [
  ...STORES.amazon.hosts,
  ...STORES.mediamarkt.hosts,
  ...STORES.pccomponentes.hosts,
];

export interface PricePageReader {
  read(
    url: string,
    permit: (url: string) => Promise<boolean>,
  ): Promise<{ status: number; html: string }>;
  close(): Promise<void>;
}

type PermitFn = (url: string) => Promise<boolean>;

/** Servidor loopback efimero que expone el `permit` de cada lectura al sidecar. */
class PermitHook {
  private server: Server | null = null;
  private port = 0;
  private readonly permits = new Map<string, PermitFn>();

  private async ensure(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      const id = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.split('/')[2] ?? '';
      const permit = this.permits.get(id);
      if (!permit) {
        res.writeHead(403).end();
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void (async () => {
          let allow = false;
          try {
            // Dos fases (#130 ronda 4): PREFLIGHT {url, resource_type} antes
            // del fetch -> robots/presupuesto (reserve descuenta por intento,
            // como el historico); POSTFLIGHT {url, resource_type, status,
            // body} tras el fetch de un salto -> SOLO isBlockedPage (el
            // presupuesto ya se desconto en preflight; no contar dos veces).
            const payload = JSON.parse(body || '{}') as {
              url?: unknown;
              status?: unknown;
              body?: unknown;
            };
            const url = String(payload.url ?? '');
            if (typeof payload.status === 'number') {
              const pageBody = typeof payload.body === 'string' ? payload.body : '';
              allow = Boolean(url) && !isBlockedPage(payload.status, pageBody);
            } else {
              allow = Boolean(url) && (await permit(url));
            }
          } catch {
            allow = false;
          }
          res.writeHead(allow ? 200 : 403).end();
        })();
      });
    });
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Registra un permit y devuelve su URL + liberador. */
  async register(permit: PermitFn): Promise<{ url: string; release: () => void }> {
    await this.ensure();
    const id = randomUUID();
    this.permits.set(id, permit);
    return {
      url: `http://127.0.0.1:${this.port}/permit/${id}`,
      release: () => this.permits.delete(id),
    };
  }

  async close(): Promise<void> {
    this.permits.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }
}

export class CamoufoxPriceBrowser implements PricePageReader {
  private readonly client: BrowserdClient;
  private readonly hook = new PermitHook();
  constructor(client: BrowserdClient = new BrowserdClient()) {
    this.client = client;
  }
  async read(
    url: string,
    permit: (url: string) => Promise<boolean>,
  ): Promise<{ status: number; html: string }> {
    if (!usesPublicBrowser(url)) return { status: 403, html: '' };
    const { url: permitUrl, release } = await this.hook.register(permit);
    let nav: { status: number; denied?: boolean };
    let html = '';
    try {
      // Lectura atomica en el sidecar: goto+evaluate+cierre de pagina, sin
      // pagina viva entre lecturas (nada de JS en idle con red libre, #130).
      const r = await this.client.readPage(url, {
        expression: 'document.documentElement.outerHTML',
        allowedHosts: [...PUBLIC_STORE_HOSTS],
        permitUrl,
      });
      nav = r;
      html = typeof r.value === 'string' ? r.value : '';
      if (r.denied || r.status === 403) return { status: 403, html: '' };
      if (r.status >= 300 && r.status < 400) return { status: r.status, html: '' };
    } catch (err) {
      if (err instanceof BrowserdError) throw err; // transporte: lo gestiona el fallback
      if (err instanceof BrowserdHttpError) return { status: 0, html: '' }; // sidecar vivo, navegacion fallida
      throw err; // bug: propaga
    } finally {
      release();
    }
    if (isBlockedPage(nav.status, html)) return { status: 403, html: '' };
    return { status: nav.status, html };
  }
  async close(): Promise<void> {
    await Promise.all([this.client.close().catch(() => undefined), this.hook.close()]);
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
