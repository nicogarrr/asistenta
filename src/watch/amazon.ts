/**
 * Vigilante de errores de precio en Amazon.es (lista de ASIN en vivo, historial en SQLite).
 *
 * Decisiones, y por qué:
 * - Este módulo no hace red ni envía nada: `fetchPage`, `sleep` y `notify` se inyectan. Así se
 *   prueba sin tocar Amazon y el token de Telegram nunca pasa por aquí (lo lee el script).
 * - Cadencia conservadora: mínimo 30 s entre páginas (el mínimo se fuerza en código, la
 *   config solo puede subirlo). Ante captcha, 429 o 503 se PARA la pasada y se bloquea el
 *   vigilante unas horas: insistir contra un antibot solo empeora el bloqueo.
 * - Una lectura sin precio legible NO es un precio: se guarda como fallo, nunca como 0.
 * - Alerta solo con historia suficiente: >= 5 lecturas previas repartidas en >= 3 días.
 *   Antes no hay mediana fiable y se calla.
 * - Umbral: precio >= 60 % por debajo de la mediana reciente, o <= 15 EUR con mediana
 *   >= 100 EUR. Se etiqueta "posible error de precio": es una sospecha, no un hecho.
 */

import type { DatabaseSync } from 'node:sqlite';

export const MIN_GAP_MS = 30_000;
export const MIN_READINGS = 5;
export const MIN_SPAN_MS = 3 * 24 * 3600 * 1000;
export const WINDOW_MS = 30 * 24 * 3600 * 1000;
export const DROP_RATIO = 0.4; // precio <= 40 % de la mediana = 60 % o más por debajo
export const ABS_PRICE_CENTS = 1500;
export const ABS_MEDIAN_CENTS = 10_000;
export const BLOCK_MS = 6 * 3600 * 1000;
export const REALERT_MS = 24 * 3600 * 1000;

const ASIN = /^[A-Z0-9]{10}$/;

export function isAsin(s: string): boolean {
  return ASIN.test(s);
}

export function productUrl(asin: string): string {
  return `https://www.amazon.es/dp/${asin}`;
}

/** "1.299,50 €" / "12,34€" -> céntimos; null si el formato es ambiguo. */
export function parseEuroCents(raw: string): number | null {
  const m = raw.match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s?€/);
  if (!m?.[1]) return null;
  const euros = Number(m[1].replace(/\./g, ''));
  const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return euros * 100 + cents;
}

/** Precio visible de la ficha: primer `a-offscreen` (el precio a pagar). null = no legible. */
export function extractPriceCents(html: string): number | null {
  const m = html.match(/class="a-offscreen"[^>]*>\s*([^<]+?)\s*</);
  return m?.[1] ? parseEuroCents(m[1]) : null;
}

export function isBlockedPage(status: number, html: string): boolean {
  if (status === 429 || status === 503) return true;
  return /validateCaptcha|Introduce los caracteres|Enter the characters you see|api-services-support@amazon/i.test(
    html,
  );
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

export interface Reading {
  ts: number;
  cents: number;
}

export interface Suspicion {
  cents: number;
  medianCents: number;
  readings: number;
  spanDays: number;
  reason: 'caida' | 'absoluto';
}

/** `history` = lecturas previas (sin la actual). null = nada que avisar. */
export function detect(cents: number, history: Reading[], now: number): Suspicion | null {
  const recent = history.filter((r) => now - r.ts <= WINDOW_MS);
  if (recent.length < MIN_READINGS) return null;
  const span = Math.max(...recent.map((r) => r.ts)) - Math.min(...recent.map((r) => r.ts));
  if (span < MIN_SPAN_MS) return null;
  const med = median(recent.map((r) => r.cents));
  const base = {
    cents,
    medianCents: med,
    readings: recent.length,
    spanDays: Math.floor(span / 86_400_000),
  };
  if (cents <= med * DROP_RATIO) return { ...base, reason: 'caida' };
  if (cents <= ABS_PRICE_CENTS && med >= ABS_MEDIAN_CENTS) return { ...base, reason: 'absoluto' };
  return null;
}

const eur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

export function alertText(asin: string, s: Suspicion): string {
  const pct = Math.round((1 - s.cents / s.medianCents) * 100);
  return [
    `Posible error de precio (sospecha, sin confirmar): ${asin}`,
    `Ahora ${eur(s.cents)}, mediana reciente ${eur(s.medianCents)} (${pct} % menos).`,
    `Base: ${s.readings} lecturas en ${s.spanDays} días, Amazon.es.`,
    productUrl(asin),
  ].join('\n');
}

export class AmazonStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS amazon_readings (asin TEXT NOT NULL, ts INTEGER NOT NULL, cents INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS amazon_readings_asin_ts ON amazon_readings (asin, ts);
      CREATE TABLE IF NOT EXISTS amazon_alerts (asin TEXT NOT NULL, ts INTEGER NOT NULL, cents INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS amazon_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
  }

  history(asin: string): Reading[] {
    return this.db
      .prepare('SELECT ts, cents FROM amazon_readings WHERE asin = ? AND ts >= ? ORDER BY ts')
      .all(asin, this.now() - WINDOW_MS) as unknown as Reading[];
  }

  record(asin: string, cents: number): void {
    this.db
      .prepare('INSERT INTO amazon_readings (asin, ts, cents) VALUES (?, ?, ?)')
      .run(asin, this.now(), cents);
  }

  alertedRecently(asin: string): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM amazon_alerts WHERE asin = ? AND ts >= ?')
      .get(asin, this.now() - REALERT_MS) as { n: number };
    return row.n > 0;
  }

  markAlerted(asin: string, cents: number): void {
    this.db
      .prepare('INSERT INTO amazon_alerts (asin, ts, cents) VALUES (?, ?, ?)')
      .run(asin, this.now(), cents);
  }

  blockedUntil(): number {
    const row = this.db.prepare("SELECT v FROM amazon_meta WHERE k = 'blocked_until'").get() as
      | { v: number }
      | undefined;
    return row?.v ?? 0;
  }

  block(): void {
    this.db
      .prepare(
        "INSERT INTO amazon_meta (k, v) VALUES ('blocked_until', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      )
      .run(this.now() + BLOCK_MS);
  }
}

export interface RunDeps {
  store: AmazonStore;
  asins: string[];
  gapMs: number;
  now: () => number;
  fetchPage: (url: string) => Promise<{ status: number; html: string }>;
  sleep: (ms: number) => Promise<void>;
  notify: (text: string) => Promise<void>;
}

export interface RunSummary {
  checked: number;
  alerts: number;
  failures: number;
  stopped: 'blocked' | 'already-blocked' | null;
}

export async function runOnce(d: RunDeps): Promise<RunSummary> {
  const out: RunSummary = { checked: 0, alerts: 0, failures: 0, stopped: null };
  if (d.store.blockedUntil() > d.now()) {
    out.stopped = 'already-blocked';
    return out;
  }
  const gap = Math.max(d.gapMs, MIN_GAP_MS);
  const asins = [...new Set(d.asins.filter(isAsin))];
  for (const [i, asin] of asins.entries()) {
    if (i > 0) await d.sleep(gap);
    let page: { status: number; html: string };
    try {
      page = await d.fetchPage(productUrl(asin));
    } catch {
      out.failures++;
      continue;
    }
    if (isBlockedPage(page.status, page.html)) {
      d.store.block();
      out.stopped = 'blocked';
      return out;
    }
    const cents = page.status === 200 ? extractPriceCents(page.html) : null;
    if (cents === null || cents <= 0) {
      out.failures++;
      continue;
    }
    out.checked++;
    const suspicion = detect(cents, d.store.history(asin), d.now());
    d.store.record(asin, cents);
    if (suspicion && !d.store.alertedRecently(asin)) {
      await d.notify(alertText(asin, suspicion));
      d.store.markAlerted(asin, cents);
      out.alerts++;
    }
  }
  return out;
}
