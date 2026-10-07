import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { scanOnce } from '../src/watch/listscan.js';
import { PriceStore } from '../src/watch/pricewatch.js';
import { realDeps } from '../src/watch/pricewatch-runner.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
for (const status of [403, 429, 503, 0])
  it(`robots unavailable ${status}: deny, pause, never cache permission`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-robots-'));
    dirs.push(dir);
    const cfg = join(dir, 'config.json');
    const dbPath = join(dir, 'db.sqlite');
    writeFileSync(cfg, JSON.stringify({ enabled: true }));
    const send = vi.fn(async () => {
      if (!status) throw Error('network');
      return new Response('', { status });
    });
    vi.stubGlobal('fetch', send);
    const d = realDeps(cfg, dbPath, { info() {}, warn() {} });
    expect(await d.robotsAllows('https://www.mediamarkt.es/tv')).toBe(false);
    const db = new DatabaseSync(dbPath);
    const store = new PriceStore(db, d.now);
    expect(store.blockedUntil('www.mediamarkt.es')).toBeGreaterThan(d.now());
    expect(await d.robotsAllows('https://www.mediamarkt.es/tv')).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    db.close();
    await d.closeCycle?.();
  });
it('managed browser budget at cap-1 never gains an extra outer document count', async () => {
  const db = new DatabaseSync(':memory:');
  const now = () => Date.UTC(2026, 9, 7, 10);
  const store = new PriceStore(db, now);
  const key = 'reqs:www.mediamarkt.es:2026-10-07';
  store.setMeta(key, 9);
  await scanOnce({
    store,
    listings: [
      { store: 'mediamarkt', category: 'tv', url: 'https://www.mediamarkt.es/tv', pages: 1 },
    ],
    minDropPct: 70,
    pagesPerRun: 1,
    dailyCap: 10,
    maxCandidates: 1,
    gapMs: 30000,
    now,
    random: () => 0,
    sleep: async () => {},
    notify: async () => {},
    robotsAllows: async () => true,
    managesRequestBudget: true,
    fetchPage: async () => {
      store.setMeta(key, store.getMeta(key) + 1);
      return { status: 200, html: '' };
    },
  });
  expect(store.getMeta(key)).toBe(10);
  db.close();
});

it('robots request itself consumes the final slot and no second request is issued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-cap-'));
  dirs.push(dir);
  const cfg = join(dir, 'config.json');
  const dbPath = join(dir, 'db.sqlite');
  writeFileSync(cfg, JSON.stringify({ enabled: true, scan: { dailyRequestsPerStore: 10 } }));
  const d = realDeps(cfg, dbPath, { info() {}, warn() {} });
  const db = new DatabaseSync(dbPath);
  const store = new PriceStore(db, d.now);
  const key = `reqs:www.mediamarkt.es:${new Date(d.now()).toISOString().slice(0, 10)}`;
  store.setMeta(key, 9);
  const send = vi.fn(async () => new Response('User-agent: *', { status: 200 }));
  vi.stubGlobal('fetch', send);
  expect(await d.robotsAllows('https://www.mediamarkt.es/tv')).toBe(true);
  expect(store.getMeta(key)).toBe(10);
  expect(await d.robotsAllows('https://www.mediamarkt.es/tv')).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(store.getMeta(key)).toBe(10);
  db.close();
  await d.closeCycle?.();
});
