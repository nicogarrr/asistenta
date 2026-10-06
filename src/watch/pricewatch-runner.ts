/**
 * Un ciclo completo del vigilante de precios: barrido de listados (capa A) + verificación en
 * ficha de los candidatos y de los productos fijos de la config (capa B). Lo usan el bucle
 * interno de Asistenta (pricewatch-loop.ts) y la CLI manual (pricewatch-cli.ts).
 *
 * Config (JSON, `<estado>/pricewatch.json` o PRICEWATCH_CONFIG), releída en cada ciclo:
 * { "enabled": true, "minDropPct": 70, "gapSeconds": 30,
 *   "scan": { "enabled": true, "pagesPerRun": 5, "dailyRequestsPerStore": 170,
 *             "maxCandidates": 10, "cycleMinutes": 30 },
 *   "products": [],
 *   "telegram": { "enabled": true, "chatId": "<id>", "tokenFile": "<ruta privada>" } }
 * El token NUNCA va en la config ni en logs: solo en `tokenFile` o en PRICEWATCH_TG_TOKEN.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { type Candidate, parseScanConfig, type ScanSummary, scanOnce } from './listscan.js';
import {
  hostOf,
  MIN_GAP_MS,
  PriceStore,
  type Product,
  parseConfig,
  robotsDisallows,
  runOnce,
  STORES,
} from './pricewatch.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept-language': 'es-ES,es;q=0.9',
  accept: 'text/html,application/xhtml+xml',
};

export interface CycleLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface CycleDeps {
  readConfig: () => unknown;
  openDb: () => DatabaseSync;
  makeNotify: (cfg: ReturnType<typeof parseConfig>) => (text: string) => Promise<void>;
  fetchPage: (url: string) => Promise<{ status: number; html: string }>;
  robotsAllows: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  log: CycleLog;
}

export interface CycleResult {
  ran: boolean;
  cycleMinutes: number;
  scan?: ScanSummary;
}

const dayNum = (ms: number): number =>
  Number(new Date(ms).toISOString().slice(0, 10).replace(/-/g, ''));
const dayStr = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function bump(store: PriceStore, key: string, n: number): void {
  if (n > 0) store.setMeta(key, store.getMeta(key) + n);
}

function reportText(store: PriceStore, day: number, when: number): string {
  const g = (k: string) => store.getMeta(`stat:${day}:${k}`);
  const iso = `${String(day).slice(0, 4)}-${String(day).slice(4, 6)}-${String(day).slice(6, 8)}`;
  const lines: string[] = [];
  for (const s of Object.values(STORES)) {
    const host = `www.${s.hosts[0]}`;
    const reqs = store.getMeta(`reqs:${host}:${iso}`);
    if (reqs > 0) lines.push(`- ${s.name}: ${reqs} peticiones`);
  }
  void when;
  return [
    `Vigilante de precios, resumen del ${iso}:`,
    `${g('pages')} listados leídos, ${g('cards')} productos vistos, ${g('cands')} candidatos, ${g('alerts')} avisos, ${g('blocked')} bloqueos de tienda.`,
    ...lines,
    lines.length === 0 ? 'Ninguna tienda respondió ese día.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export async function runCycle(d: CycleDeps): Promise<CycleResult> {
  const raw = d.readConfig();
  const cfg = parseConfig(raw);
  const sc = parseScanConfig(raw);
  const cycleMinutes = cycleMinutesOf(raw);
  if (!cfg.enabled) return { ran: false, cycleMinutes };
  const db = d.openDb();
  try {
    const store = new PriceStore(db, d.now);
    store.prune();
    const notify = d.makeNotify(cfg);
    const today = dayNum(d.now());
    const last = store.getMeta('report_day');
    if (last === 0) {
      store.setMeta('report_day', today);
      await notify(
        `Vigilante de precios activo. Barrido de listados: ${sc.enabled ? 'sí' : 'no'}, tope ${sc.dailyRequestsPerStore} peticiones/día por tienda, umbral ${cfg.minDropPct} %. Te aviso aquí de posibles errores de precio y de las tiendas que bloqueen tu IP.`,
      );
    } else if (last !== today) {
      await notify(reportText(store, last, d.now()));
      store.setMeta('report_day', today);
    }
    const common = {
      store,
      gapMs: cfg.gapMs,
      minDropPct: cfg.minDropPct,
      now: d.now,
      random: d.random,
      sleep: d.sleep,
      notify,
      robotsAllows: d.robotsAllows,
      fetchPage: d.fetchPage,
    };
    let scan: ScanSummary | undefined;
    let candidates: Candidate[] = [];
    if (sc.enabled) {
      scan = await scanOnce({
        ...common,
        listings: sc.listings,
        pagesPerRun: sc.pagesPerRun,
        dailyCap: sc.dailyRequestsPerStore,
        maxCandidates: sc.maxCandidates,
      });
      candidates = scan.candidates;
      bump(store, `stat:${today}:pages`, scan.pages);
      bump(store, `stat:${today}:cards`, scan.cards);
      bump(store, `stat:${today}:cands`, candidates.length);
    }
    const fixed: Product[] = cfg.products;
    const products: Product[] = [
      ...fixed,
      ...candidates.map((c) => ({ name: c.key, label: c.title, urls: { [c.store]: c.url } })),
    ];
    const blockedHosts = new Set<string>(scan?.blockedStores ?? []);
    if (products.length > 0) {
      if (candidates.length > 0) await d.sleep(MIN_GAP_MS);
      const v = await runOnce({
        ...common,
        products,
        dailyCap: sc.enabled ? sc.dailyRequestsPerStore : undefined,
      });
      bump(store, `stat:${today}:alerts`, v.alerts);
      for (const h of v.blockedStores) blockedHosts.add(h);
      d.log.info('pricewatch verificacion', { ...v });
    }
    for (const host of blockedHosts) {
      const key = `blocknotice:${host}:${dayStr(d.now())}`;
      if (store.getMeta(key) > 0) continue;
      store.setMeta(key, 1);
      bump(store, `stat:${today}:blocked`, 1);
      const mins = Math.max(1, Math.round((store.blockedUntil(host) - d.now()) / 60_000));
      await notify(
        `Vigilante de precios: ${host} está bloqueando las peticiones desde tu IP (403/captcha). Lo dejo en espera ${mins} min y reintento con pausas crecientes.`,
      );
    }
    if (scan)
      d.log.info('pricewatch barrido', {
        pages: scan.pages,
        cards: scan.cards,
        candidates: candidates.length,
        failures: scan.failures,
        blocked: scan.blockedStores,
        noCards: scan.noCardStores,
        capped: scan.capped,
      });
    return { ran: true, cycleMinutes, scan };
  } finally {
    db.close();
  }
}

export function cycleMinutesOf(raw: unknown): number {
  const s = (raw as { scan?: { cycleMinutes?: unknown } } | null)?.scan;
  const v = s?.cycleMinutes;
  return typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 1440 ? v : 30;
}

const robotsCache = new Map<string, string>();

export function realDeps(
  configPath: string,
  dbPath: string,
  log: CycleLog,
  stdoutOnly = false,
): CycleDeps {
  return {
    readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as unknown,
    openDb: () => new DatabaseSync(dbPath),
    makeNotify: (cfg) => {
      const t = cfg.telegram;
      const out = async (text: string) => {
        log.info('pricewatch aviso', { text });
        if (stdoutOnly) process.stdout.write(`[aviso]\n${text}\n`);
      };
      if (!t.enabled || !t.chatId) return out;
      const token = (
        process.env.PRICEWATCH_TG_TOKEN ?? (t.tokenFile ? readTokenFile(t.tokenFile) : '')
      ).trim();
      if (!token) {
        log.warn('pricewatch: telegram.enabled pero sin token legible (tokenFile)');
        return out;
      }
      return async (text) => {
        await out(text);
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: t.chatId, text, disable_web_page_preview: true }),
          });
          if (!res.ok) log.warn('pricewatch: telegram sendMessage falló', { status: res.status });
        } catch {
          log.warn('pricewatch: telegram sendMessage sin conexión');
        }
      };
    },
    fetchPage: async (url) => {
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, html: await res.text() };
    },
    robotsAllows: async (url) => {
      const host = hostOf(url);
      if (!robotsCache.has(host)) {
        try {
          const res = await fetch(`https://${host}/robots.txt`, {
            headers: HEADERS,
            signal: AbortSignal.timeout(15_000),
          });
          robotsCache.set(host, res.ok ? await res.text() : '');
        } catch {
          robotsCache.set(host, '');
        }
      }
      const u = new URL(url);
      return !robotsDisallows(robotsCache.get(host) ?? '', u.pathname + u.search);
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: Date.now,
    random: Math.random,
    log,
  };
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
