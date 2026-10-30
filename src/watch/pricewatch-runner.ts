import { PublicPriceBrowser, usesPublicBrowser } from './pricewatch-browser.js';
import { createPricePageReader } from './pricewatch-browserd.js';
import { pricewatchNotifier } from './pricewatch-notify.js';
/**
 * Un ciclo completo del vigilante de precios: barrido de listados (capa A) + verificación en
 * ficha de los candidatos y de los productos fijos de la config (capa B). Lo usan el bucle
 * interno de Asistenta (pricewatch-loop.ts) y la CLI manual (`pa precio`, pricewatch-cli.ts).
 *
 * Config (JSON, `<estado>/pricewatch.json` o PRICEWATCH_CONFIG), releída en cada ciclo:
 * { "enabled": true, "minDropPct": 70, "gapSeconds": 30,
 *   "scan": { "enabled": true, "pagesPerRun": 5, "dailyRequestsPerStore": 170,
 *             "maxCandidates": 10, "cycleMinutes": 60 },
 *   "products": [],
 *   "telegram": { "enabled": true, "chatId": "<id>", "tokenFile": "<ruta privada>" } }
 * El token NUNCA va en la config ni en logs: solo en `tokenFile` o en PRICEWATCH_TG_TOKEN.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { localDay } from '../datecontext.js';
import { logHost } from '../log.js';
import { curlImpersonateFetch, findCurlImpersonate } from '../media/download.js';
import {
  type Candidate,
  coverageText,
  parseScanConfig,
  type ScanSummary,
  scanOnce,
} from './listscan.js';
import {
  hostOf,
  isBlockedPage,
  MIN_GAP_MS,
  PriceStore,
  type Product,
  parseConfig,
  robotsDisallows,
  runOnce,
  STORES,
  type StoreId,
} from './pricewatch.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept-language': 'es-ES,es;q=0.9',
  accept: 'text/html,application/xhtml+xml',
};

/** Wait before retry n (1-based): 5s, 20s, 60s, 120s, then held at 120s. */
export function backoffMs(attempt: number): number {
  return Math.min(120_000, 5_000 * 4 ** (attempt - 1));
}

/**
 * Statuses that mean "try again later", as opposed to "this page does not exist".
 *
 * 403 is here on purpose for the Amazon case: it is a refusal, not a missing page, and the
 * scanner used to treat it as a dead store for the rest of the day.
 */
export const BACKOFF_STATUS = new Set([403, 429, 503]);

/** One HTTP client, no retry after refusal. Store backoff belongs to the scanner. */
export async function fetchTolerant(
  url: string,
  _sleep: (ms: number) => Promise<void>,
  log: CycleLog,
): Promise<{ status: number; html: string }> {
  // One HTTP request only. A refusal never triggers another client/identity.
  // Store-level backoff and caps are owned by scanOnce/runOnce.
  try {
    const bin = await findCurlImpersonate(process.env.PA_CURL_IMPERSONATE ?? '');
    const client = bin ? curlImpersonateFetch(bin) : fetch;
    const res = await client(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) });
    return { status: res.status, html: await res.text() };
  } catch {
    log.warn('pricewatch: petición fallida', { url: logHost(url) });
    return { status: 0, html: '' };
  }
}

export interface CycleLog {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface CycleDeps {
  readConfig: () => unknown;
  openDb: () => DatabaseSync;
  makeNotify: (cfg: ReturnType<typeof parseConfig>) => (text: string) => Promise<void>;
  managesRequestBudget?: boolean;
  fetchPage: (url: string) => Promise<{ status: number; html: string }>;
  robotsAllows: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  log: CycleLog;
  closeCycle?: () => Promise<void>;
}

export interface CycleResult {
  ran: boolean;
  cycleMinutes: number;
  scan?: ScanSummary;
}

const dayNum = (ms: number): number => Number(localDay(ms).replace(/-/g, ''));
const dayStr = (ms: number): string => localDay(ms);

function bump(store: PriceStore, key: string, n: number): void {
  if (n > 0) store.setMeta(key, store.getMeta(key) + n);
}

function reportText(
  store: PriceStore,
  day: number,
  when: number,
  listings: Parameters<typeof coverageText>[1] = [],
): string {
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
    `${g('unref')} productos vistos sin referencia (observaciones, no alarmas) y ${g('terms')} términos de búsqueda nuevos descubiertos en tarjetas de Amazon.`,
    ...lines,
    listings.length > 0 ? coverageText(store, listings, iso) : '',
    lines.length === 0 ? 'Ninguna tienda respondió ese día.' : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function resetPublicReaderPause(store: PriceStore, day: string): void {
  // Upgrade only the parser/no-card pause; preserve real 403 backoff and request budget.
  if (store.getMeta('public_reader_v1') > 0) return;
  for (const id of ['amazon', 'mediamarkt', 'pccomponentes'] as const) {
    store.setMeta(`nocards_off:${id}:${day}`, 0);
    store.setMeta(`nocards:${id}`, 0);
  }
  store.setMeta('public_reader_v1', 1);
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
    resetPublicReaderPause(store, dayStr(d.now()));
    const notify = d.makeNotify(cfg);
    const today = dayNum(d.now());
    const last = store.getMeta('report_day');
    if (last === 0) {
      store.setMeta('report_day', today);
      const pausedNote =
        sc.pausedStores.length > 0
          ? ` En pausa: ${sc.pausedStores.map((id) => STORES[id].name).join(' y ')} (bloqueaban tu IP; para reactivarlas pon "pausedStores": [] en la config).`
          : '';
      await notify(
        `Vigilante de precios activo. Barrido de listados: ${sc.enabled ? 'sí' : 'no'}, cada ${cycleMinutes} min, tope ${sc.dailyRequestsPerStore} peticiones/día por tienda, umbral ${cfg.minDropPct} %. Te aviso aquí de posibles errores de precio y de las tiendas que bloqueen tu IP.${pausedNote}`,
      );
    } else if (last !== today) {
      await notify(reportText(store, last, d.now(), sc.enabled ? sc.listings : []));
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
      managesRequestBudget: d.managesRequestBudget,
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
        discover: sc.discover,
      });
      candidates = scan.candidates;
      bump(store, `stat:${today}:unref`, scan.unreferenced);
      bump(store, `stat:${today}:terms`, scan.newTerms.length);
      bump(store, `stat:${today}:pages`, scan.pages);
      bump(store, `stat:${today}:cards`, scan.cards);
      bump(store, `stat:${today}:cands`, candidates.length);
    }
    // La pausa también cubre las fichas fijas: una tienda en pausa no recibe peticiones.
    const pausedSet = new Set<StoreId>(sc.pausedStores);
    const fixed: Product[] = cfg.products
      .map((p) => ({
        ...p,
        urls: Object.fromEntries(
          Object.entries(p.urls).filter(([s]) => !pausedSet.has(s as StoreId)),
        ),
      }))
      .filter((p) => Object.keys(p.urls).length > 0);
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
      // Días seguidos bloqueando: un baneo largo (como el de MediaMarkt del 11-oct)
      // no es un "reintento en X min", y el mensaje tiene que decirlo.
      const streakKey = `blockstreak:${host}`;
      const streak =
        store.getMeta(`blocknotice:${host}:${dayStr(d.now() - 24 * 3600 * 1000)}`) > 0
          ? store.getMeta(streakKey) + 1
          : 1;
      store.setMeta(streakKey, streak);
      const mins = Math.max(1, Math.round((store.blockedUntil(host) - d.now()) / 60_000));
      await notify(
        streak >= 2
          ? `Vigilante de precios: ${host} lleva ${streak} días seguidos bloqueando tu IP (403/captcha). Puede ser un baneo largo: lo dejo en espera y las demás tiendas siguen.`
          : `Vigilante de precios: ${host} está bloqueando las peticiones desde tu IP (403/captcha). Lo dejo en espera ${mins} min y reintento con pausas crecientes.`,
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
    await d.closeCycle?.();
  }
}

export function cycleMinutesOf(raw: unknown): number {
  const s = (raw as { scan?: { cycleMinutes?: unknown } } | null)?.scan;
  const v = s?.cycleMinutes;
  return typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 1440 ? v : 60;
}

export function realDeps(
  configPath: string,
  dbPath: string,
  log: CycleLog,
  stdoutOnly = false,
  mainBotToken = '',
): CycleDeps {
  // BROWSER_ENGINE=camoufox enruta por el sidecar browserd con fallback a playwright.
  const browser = createPricePageReader(new PublicPriceBrowser());
  const robotsCache = new Map<string, { text: string; day: string }>();
  const reserve = (url: string): boolean => {
    const db = deps.openDb();
    try {
      const store = new PriceStore(db, deps.now);
      const host = hostOf(url);
      if (store.blockedUntil(host) > deps.now()) return false;
      const cap = parseScanConfig(deps.readConfig()).dailyRequestsPerStore;
      const key = `reqs:${host}:${dayStr(deps.now())}`;
      if (store.getMeta(key) >= cap) return false;
      store.setMeta(key, store.getMeta(key) + 1);
      return true;
    } finally {
      db.close();
    }
  };
  const pauseRobots = (host: string): false => {
    const db = deps.openDb();
    try {
      new PriceStore(db, deps.now).block(host);
    } finally {
      db.close();
    }
    log.warn('pricewatch: robots no verificable, tienda en pausa', { host });
    return false;
  };
  const deps: CycleDeps = {
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
      return pricewatchNotifier({
        token,
        mainBotToken: t.useMainBotFallback ? mainBotToken : '',
        chatId: t.chatId,
        out,
        log,
      });
    },
    managesRequestBudget: true,
    fetchPage: async (url) => {
      if (!usesPublicBrowser(url)) {
        if (!(await deps.robotsAllows(url)) || !reserve(url)) return { status: 0, html: '' };
        return fetchTolerant(url, deps.sleep, log);
      }
      return browser.read(url, async (requestUrl) => {
        if (!(await deps.robotsAllows(requestUrl))) return false;
        return reserve(requestUrl);
      });
    },
    closeCycle: () => browser.close(),
    robotsAllows: async (url) => {
      const host = hostOf(url);
      const db = deps.openDb();
      try {
        if (new PriceStore(db, deps.now).blockedUntil(host) > deps.now()) return false;
      } finally {
        db.close();
      }
      const cached = robotsCache.get(host);
      if (!cached || cached.day !== dayStr(deps.now())) {
        if (!reserve(url)) return false;
        try {
          const res = await fetch(`https://${host}/robots.txt`, {
            headers: HEADERS,
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          });
          const text = await res.text();
          if (!res.ok || isBlockedPage(res.status, text)) return pauseRobots(host);
          robotsCache.set(host, { text, day: dayStr(deps.now()) });
        } catch {
          return pauseRobots(host);
        }
      }
      const u = new URL(url);
      return !robotsDisallows(robotsCache.get(host)?.text ?? '', u.pathname + u.search);
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now: Date.now,
    random: Math.random,
    log,
  };
  return deps;
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
