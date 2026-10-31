/**
 * Lectura del precio de una ficha de tienda (Amazon.es, MediaMarkt, PcComponentes, Carrefour,
 * El Corte Inglés, Fnac, Worten): lo usan la vigilancia de un enlace concreto («vigila este
 * enlace», src/watch/pages.ts) y /compara (src/watch/compare.ts).
 *
 * - Extracción multi-estrategia con consenso: JSON-LD (schema.org Product/Offer), metaetiquetas
 *   y microdatos, y como último recurso el selector propio de la tienda (Amazon). Si dos fuentes
 *   de la misma ficha discrepan más de un 2 %, la lectura es "no fiable".
 * - Una lectura sin precio legible NO es un precio: es fallo, nunca 0.
 * - Este módulo no hace red: recibe el HTML ya descargado.
 *
 * (El barrido automático de catálogos de tiendas, «vigilante de precios», se quitó por decisión
 * del dueño el 31-oct-2026.)
 */

import { urlHostname } from '../text.js';

export const SOURCE_TOLERANCE = 0.02;

export type StoreId =
  | 'amazon'
  | 'mediamarkt'
  | 'pccomponentes'
  | 'carrefour'
  | 'elcorteingles'
  | 'fnac'
  | 'worten';

export const STORES: Record<StoreId, { name: string; hosts: string[] }> = {
  amazon: { name: 'Amazon.es', hosts: ['amazon.es'] },
  mediamarkt: { name: 'MediaMarkt', hosts: ['mediamarkt.es'] },
  pccomponentes: { name: 'PcComponentes', hosts: ['pccomponentes.com'] },
  carrefour: { name: 'Carrefour', hosts: ['carrefour.es'] },
  elcorteingles: { name: 'El Corte Inglés', hosts: ['elcorteingles.es'] },
  fnac: { name: 'Fnac', hosts: ['fnac.es'] },
  worten: { name: 'Worten', hosts: ['worten.es'] },
};

const ASIN = /^[A-Z0-9]{10}$/;

export function isAsin(s: string): boolean {
  return ASIN.test(s);
}

export function isStoreId(s: string): s is StoreId {
  return Object.hasOwn(STORES, s);
}

export function hostOf(url: string): string {
  return urlHostname(url) ?? '';
}

function hostBelongs(host: string, store: StoreId): boolean {
  return STORES[store].hosts.some(
    (h) => host === h || host === `www.${h}` || host.endsWith(`.${h}`),
  );
}

/** Referencia de la config -> URL de producto, o null si no es válida para esa tienda. */
export function toUrl(store: StoreId, ref: string): string | null {
  if (store === 'amazon' && isAsin(ref)) return `https://www.amazon.es/dp/${ref}`;
  try {
    const u = new URL(ref);
    if (u.protocol !== 'https:' || !hostBelongs(u.hostname.toLowerCase(), store)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Cifra en euros: miles con punto o con espacio, decimales con coma; o punto decimal
// («1299.99 €», «12.5 €», «1,299.99 €»: el punto con 1-2 cifras detrás solo puede ser
// decimal). Un número pegado con espacio normal delante («1 299.99 €») no se lee como
// 299,99 €. EURO_RE no toma el espacio NORMAL como separador de miles.
const EN_DECIMAL = String.raw`(?<!\d )(\d{1,3}(?:,\d{3})+|\d+)\.(\d{1,2})`;
const EURO_RE = new RegExp(
  String.raw`(?<![\d.,\u00a0\u202f\u2009]|\d )(?:(\d{1,3}(?:[.\u00a0\u202f\u2009]\d{3})+|\d+)(?:,(\d{1,2}))?|${EN_DECIMAL})\s?€`,
);
const EURO_PLAIN_SPACE_RE = new RegExp(
  String.raw`(?<![\d.,\u00a0\u202f\u2009])(?:(\d{1,3}(?:[.\u00a0\u202f\u2009 ]\d{3})+|\d+)(?:,(\d{1,2}))?|${EN_DECIMAL})\s?€`,
);

/** "1.299,50 €" / "12,34€" / "1299.99 €" / "1,299.99 €" -> céntimos; un formato ambiguo da null. */
export function parseEuroCents(
  raw: string,
  opts: { plainSpaceThousands?: boolean } = {},
): number | null {
  // Miles con punto o con espacio duro U+00A0, estrecho U+202F o fino U+2009 (como
  // `Intl.NumberFormat('fr-FR')` y algunas tiendas): «1 299,00 €» son 1299 €, no 299 €.
  // Un espacio NORMAL solo separa miles con `plainSpaceThousands` (fuentes que solo
  // llevan un precio, como el `a-offscreen` de Amazon): en texto libre «talla 42 199 €»
  // no son 42199 €. Sin la opción, cifras separadas por espacio normal dan null (ni
  // 42199 ni 199: «1 299 €» tampoco puede leerse como 299 €).
  const m = raw.match(opts.plainSpaceThousands ? EURO_PLAIN_SPACE_RE : EURO_RE);
  if (!m) return null;
  const intPart = m[1] ?? m[3];
  const decPart = m[1] ? m[2] : m[4];
  if (!intPart) return null;
  const euros = Number(intPart.replace(/[.,\u00a0\u202f\u2009 ]/g, ''));
  const cents = decPart ? Number(decPart.padEnd(2, '0')) : 0;
  return euros * 100 + cents;
}

/** Número de schema.org/metaetiquetas ("1299.99", 1299.99, "1,299.99" o "1.299,00") -> céntimos. */
export function parseMachinePrice(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+(\.\d{1,2})?$/.test(s)) return Math.round(Number(s) * 100) || null;
  if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s))
    return Math.round(Number(s.replace(/,/g, '')) * 100) || null;
  if (/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(s)) return parseEuroCents(`${s} €`);
  return null;
}

export type SourceKind = 'jsonld' | 'meta' | 'selector';

export interface Extraction {
  cents: number | null;
  inStock: boolean | null;
  /** false = dos fuentes discrepan: no puede disparar alerta. */
  reliable: boolean;
  sources: { kind: SourceKind; cents: number }[];
}

function walk(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    out.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, out);
  }
}

function typeIncludes(o: Record<string, unknown>, name: string): boolean {
  const t = o['@type'];
  return t === name || (Array.isArray(t) && t.includes(name));
}

function stockFromAvailability(a: unknown): boolean | null {
  if (typeof a !== 'string') return null;
  if (/OutOfStock|SoldOut|Discontinued|PreOrder|BackOrder|PreSale/i.test(a)) return false;
  if (/InStock|LimitedAvailability|OnlineOnly|InStoreOnly/i.test(a)) return true;
  return null;
}

function jsonLd(html: string): { cents: number | null; inStock: boolean | null } {
  let cents: number | null = null;
  let inStock: boolean | null = null;
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(m[1] ?? '');
    } catch {
      continue;
    }
    const nodes: Record<string, unknown>[] = [];
    walk(data, nodes);
    for (const n of nodes) {
      if (!typeIncludes(n, 'Offer') && !typeIncludes(n, 'AggregateOffer')) continue;
      const cur = n.priceCurrency;
      if (typeof cur === 'string' && cur.toUpperCase() !== 'EUR') continue;
      // lowPrice de un AggregateOffer puede mezclar vendedores externos: solo si hay una única oferta.
      const single = Number(n.offerCount) === 1;
      const p = parseMachinePrice(n.price ?? (single ? n.lowPrice : undefined));
      if (p === null) continue;
      if (cents === null) {
        cents = p;
        inStock = stockFromAvailability(n.availability);
      }
    }
    if (cents !== null) break;
  }
  return { cents, inStock };
}

function metaPrice(html: string): number | null {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:product:price:amount|og:price:amount)["']/i,
    /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]*itemprop=["']price["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const p = m?.[1] ? parseMachinePrice(m[1]) : null;
    if (p !== null) return p;
  }
  return null;
}

const AMAZON_BLOCK =
  /id="(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)"/;

/** Precio del bloque principal de Amazon (no recomendados): primer `a-offscreen` dentro de él. */
export function amazonSelectorCents(html: string): number | null {
  const at = html.search(AMAZON_BLOCK);
  if (at < 0) return null;
  const m = html.slice(at, at + 4000).match(/class="a-offscreen"[^>]*>\s*([^<]+?)\s*</);
  return m?.[1] ? parseEuroCents(m[1], { plainSpaceThousands: true }) : null;
}

function amazonStock(html: string): boolean | null {
  const m = html.match(/id="availability"[\s\S]{0,600}/);
  if (!m) return null;
  if (/no disponible|agotado/i.test(m[0])) return false;
  if (/en stock|disponible|quedan/i.test(m[0])) return true;
  return null;
}

export function extractReading(store: StoreId, html: string): Extraction {
  const sources: Extraction['sources'] = [];
  const ld = jsonLd(html);
  if (ld.cents !== null) sources.push({ kind: 'jsonld', cents: ld.cents });
  const meta = metaPrice(html);
  if (meta !== null) sources.push({ kind: 'meta', cents: meta });
  let inStock = ld.inStock;
  if (store === 'amazon') {
    const sel = amazonSelectorCents(html);
    if (sel !== null) sources.push({ kind: 'selector', cents: sel });
    inStock = inStock ?? amazonStock(html);
  }
  const first = sources[0];
  if (!first) return { cents: null, inStock, reliable: true, sources };
  const reliable = sources.every(
    (s) => Math.abs(s.cents - first.cents) <= first.cents * SOURCE_TOLERANCE,
  );
  return { cents: first.cents, inStock, reliable, sources };
}

export function isBlockedPage(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /validateCaptcha|Introduce los caracteres|Enter the characters you see|api-services-support@amazon|cf-chl-|Just a moment\.\.\.|px-captcha|triggerInterstitialChallenge|bm-verify|akamai.*challenge|captcha-delivery\.com|geo\.captcha-delivery|Incapsula incident/i.test(
    html,
  );
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}
