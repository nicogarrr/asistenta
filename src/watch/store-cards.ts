/**
 * Tarjetas de producto (título, URL, precio) de una página de resultados de tienda, y el código
 * de modelo para emparejar el mismo producto entre tiendas. Lo usa /compara (src/watch/compare.ts).
 */

import { parseEuroCents, parseMachinePrice, type StoreId, toUrl } from './price-extract.js';

export interface Card {
  title: string;
  url: string;
  cents: number;
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

const UNIT = /^\d+(gb|tb|hz|w|kg|mah|mp|l|cm|mm|pulgadas|k|bar|rpm|db|mhz|ghz|v)$/;

/** Código de modelo (p. ej. TU65M73HAUXXC) para emparejar el mismo producto entre tiendas. */
export function modelKey(title: string): string | null {
  const lower = norm(title);
  // Solo reconstruye la familia Samsung TUxx-MxxH... documentada por
  // nuestros casos. Otros separadores quedan por URL, no por sufijo comun.
  if (/\btu\d{2}(?:\s*\/\s*|\s+)m\d{2}h[a-z0-9]+\b/.test(lower)) return null;
  if (/\ba\d{2}[-‐‑]android\d+\b/.test(lower)) return null;
  const normalized = lower.replace(/\b(tu\d{2})[-‐‑](m\d{2}h[a-z0-9]{3,9})\b/g, '$1$2');
  const tokens = normalized.split(/[^a-z0-9]+/);
  let best: string | null = null;
  for (const t of tokens) {
    if (t.length < 6 || t.length > 18) continue;
    if (!/[a-z]/.test(t) || (t.match(/\d/g) ?? []).length < 2) continue;
    if (UNIT.test(t)) continue;
    if (best === null || t.length > best.length) best = t;
  }
  return best === null ? null : `m:${best}`;
}

type Json = Record<string, unknown>;

function collect(v: unknown, out: Json[]): void {
  if (Array.isArray(v)) {
    for (const x of v) collect(x, out);
  } else if (v !== null && typeof v === 'object') {
    out.push(v as Json);
    for (const x of Object.values(v as Json)) collect(x, out);
  }
}

function typeIs(n: Json, t: string): boolean {
  const ty = n['@type'];
  return ty === t || (Array.isArray(ty) && ty.includes(t));
}

function offerCents(offers: unknown): number | null {
  const list = Array.isArray(offers) ? offers : [offers];
  for (const o of list) {
    if (o === null || typeof o !== 'object') continue;
    const n = o as Json;
    const cur = n.priceCurrency;
    if (typeof cur === 'string' && cur.toUpperCase() !== 'EUR') continue;
    const single = Number(n.offerCount) === 1;
    const p = parseMachinePrice(n.price ?? (single ? n.lowPrice : undefined));
    if (p !== null) return p;
  }
  return null;
}

function absoluteUrl(store: StoreId, raw: string, base: string): string | null {
  try {
    return toUrl(store, new URL(raw, base).toString());
  } catch {
    return null;
  }
}

function ldCards(store: StoreId, html: string, base: string): Card[] {
  const out: Card[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(m[1] ?? '');
    } catch {
      continue;
    }
    const nodes: Json[] = [];
    collect(data, nodes);
    for (const n of nodes) {
      if (!typeIs(n, 'Product')) continue;
      if (typeof n.name !== 'string' || typeof n.url !== 'string') continue;
      const cents = offerCents(n.offers);
      const url = absoluteUrl(store, n.url, base);
      if (cents === null || cents <= 0 || !url) continue;
      out.push({ title: n.name, url, cents });
    }
  }
  return out;
}

function microdataCards(store: StoreId, html: string, base: string): Card[] {
  const out: Card[] = [];
  const parts = html.split(/itemtype=["']https?:\/\/schema\.org\/Product["']/i).slice(1);
  for (const raw of parts) {
    const chunk = raw.slice(0, 4000);
    const name = /itemprop=["']name["'][^>]*?(?:content=["']([^"']+)["']|>([^<]+)<)/i.exec(chunk);
    const price = /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i.exec(chunk);
    const url = /itemprop=["']url["'][^>]*(?:href|content)=["']([^"']+)["']/i.exec(chunk);
    const title = (name?.[1] ?? name?.[2] ?? '').trim();
    const cents = parseMachinePrice(price?.[1]);
    const abs = url?.[1] ? absoluteUrl(store, url[1], base) : null;
    if (title && cents !== null && cents > 0 && abs) out.push({ title, url: abs, cents });
  }
  return out;
}

function amazonCards(html: string): Card[] {
  const out: Card[] = [];
  const re = /<div[^>]*data-component-type=["']s-search-result["'][^>]*>/gi;
  const starts: { i: number; tag: string }[] = [];
  for (const m of html.matchAll(re)) starts.push({ i: m.index ?? 0, tag: m[0] });
  starts.forEach((s, k) => {
    const chunk = html.slice(s.i, starts[k + 1]?.i ?? s.i + 20000);
    const asin = /data-asin=["']([A-Z0-9]{10})["']/.exec(s.tag)?.[1];
    if (!asin || /AdHolder|s-sponsored|puis-sponsored/i.test(chunk)) return;
    const price = /class=["']a-price["'][^>]*>\s*<span class=["']a-offscreen["']>([^<]+)</i.exec(
      chunk,
    );
    const title = /<h2[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i.exec(chunk)?.[1]?.trim();
    // `a-offscreen` holds only the price, so a plain space there separates thousands.
    const cents = price?.[1]
      ? parseEuroCents(price[1].trim(), { plainSpaceThousands: true })
      : null;
    if (title && cents !== null && cents > 0)
      out.push({ title, url: `https://www.amazon.es/dp/${asin}`, cents });
  });
  return out;
}

export function extractCards(store: StoreId, html: string, base: string): Card[] {
  const found =
    store === 'amazon'
      ? amazonCards(html)
      : (() => {
          const ld = ldCards(store, html, base);
          return ld.length > 0 ? ld : microdataCards(store, html, base);
        })();
  const seen = new Set<string>();
  return found.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}
