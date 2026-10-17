import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PriceStore } from '../src/watch/pricewatch.js';
import { startPricewatchLoop } from '../src/watch/pricewatch-loop.js';
import {
  BACKOFF_STATUS,
  type CycleDeps,
  cycleMinutesOf,
  resetPublicReaderPause,
  runCycle,
} from '../src/watch/pricewatch-runner.js';

const DAY = 86_400_000;
const MM = 'https://www.mediamarkt.es/es/category/tv.html';
const ld = (price: number) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'ItemList',
    itemListElement: [
      {
        '@type': 'ListItem',
        item: {
          '@type': 'Product',
          name: 'TV Samsung TU65M73HAUXXC',
          url: 'https://www.mediamarkt.es/es/product/tv1.html',
          offers: { '@type': 'Offer', price, priceCurrency: 'EUR' },
        },
      },
    ],
  })}</script>`;
const cfg = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  scan: {
    enabled: true,
    pagesPerRun: 1,
    // Estas pruebas ejercitan la mecánica con MediaMarkt: quitan la pausa por defecto.
    pausedStores: [],
    listings: [{ store: 'mediamarkt', category: 'tv', url: MM, pages: 1 }],
  },
  telegram: { enabled: false },
  ...over,
});

function setup(config: unknown, pages: Record<string, { status: number; html: string }> = {}) {
  let t = 10 * DAY + 3_600_000;
  const db = new DatabaseSync(':memory:');
  const sent: string[] = [];
  const fetched: string[] = [];
  const warns: string[] = [];
  const deps: CycleDeps = {
    readConfig: () => config,
    openDb: () =>
      ({
        ...db,
        close: () => undefined,
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
      }) as unknown as DatabaseSync,
    makeNotify: () => async (x) => void sent.push(x),
    fetchPage: async (u) => {
      fetched.push(u);
      return pages[u] ?? { status: 404, html: '' };
    },
    robotsAllows: async () => true,
    sleep: async () => undefined,
    now: () => t,
    random: () => 0,
    log: { info: () => undefined, warn: (m) => void warns.push(m) },
  };
  return {
    deps,
    db,
    sent,
    fetched,
    warns,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('runCycle', () => {
  it('enabled=false: ni peticiones ni avisos', async () => {
    const s = setup({ enabled: false });
    expect((await runCycle(s.deps)).ran).toBe(false);
    expect(s.fetched).toEqual([]);
    expect(s.sent).toEqual([]);
  });

  it('primer ciclo avisa de que está activo (una vez) y barre listados', async () => {
    const s = setup(cfg(), { [MM]: { status: 200, html: ld(500) } });
    const r = await runCycle(s.deps);
    expect(r.ran).toBe(true);
    expect(r.scan?.cards).toBe(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('Vigilante de precios activo');
    s.advance(60_000);
    await runCycle(s.deps);
    expect(s.sent).toHaveLength(1);
  });

  it('al cambiar de día envía el resumen del día anterior', async () => {
    const s = setup(cfg(), { [MM]: { status: 200, html: ld(500) } });
    await runCycle(s.deps);
    s.advance(DAY);
    await runCycle(s.deps);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]).toContain('resumen del 1970-01-11');
    expect(s.sent[1]).toContain('1 listados leídos');
    expect(s.sent[1]).toContain('MediaMarkt: 1 peticiones');
  });

  it('tienda bloqueada: avisa una vez al día con el host', async () => {
    const s = setup(cfg(), { [MM]: { status: 403, html: '' } });
    await runCycle(s.deps);
    s.advance(10 * 60_000);
    await runCycle(s.deps);
    const notices = s.sent.filter((x) => x.includes('bloqueando'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('www.mediamarkt.es');
  });

  it('candidato del barrido pasa a la ficha (capa B) y se lee su página', async () => {
    const s = setup(cfg(), {
      [MM]: { status: 200, html: ld(15) },
      'https://www.mediamarkt.es/es/product/tv1.html': {
        status: 200,
        html: '<html>sin precio</html>',
      },
    });
    s.db.exec(
      'CREATE TABLE IF NOT EXISTS price_readings (product TEXT NOT NULL, store TEXT NOT NULL, ts INTEGER NOT NULL, cents INTEGER NOT NULL)',
    );
    for (let i = 0; i < 5; i++)
      s.db
        .prepare('INSERT INTO price_readings (product, store, ts, cents) VALUES (?,?,?,?)')
        .run('m:tu65m73hauxxc', 'mediamarkt', 10 * DAY - (5 - i) * DAY, 50000);
    await runCycle(s.deps);
    expect(s.fetched).toContain('https://www.mediamarkt.es/es/product/tv1.html');
  });

  it('MediaMarkt y PcComponentes arrancan en pausa por defecto, con aviso al activar', async () => {
    const s = setup({
      enabled: true,
      scan: { enabled: true, pagesPerRun: 1 },
      telegram: { enabled: false },
    });
    const r = await runCycle(s.deps);
    expect(r.ran).toBe(true);
    // Los listados por defecto incluyen mediamarkt/pccomponentes: en pausa no se piden
    expect(
      s.fetched.filter((u) => u.includes('mediamarkt') || u.includes('pccomponentes')),
    ).toEqual([]);
    expect(s.sent[0]).toContain('En pausa');
    expect(s.sent[0]).toContain('MediaMarkt');
    expect(s.sent[0]).toContain('pausedStores');
  });

  it('un baneo de varios días seguidos se dice como tal, no como reintento', async () => {
    const s = setup(cfg(), { [MM]: { status: 403, html: '' } });
    await runCycle(s.deps);
    s.advance(DAY);
    await runCycle(s.deps);
    const notices = s.sent.filter((x) => x.includes('bloqueando'));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain('está bloqueando');
    expect(notices[1]).toContain('2 días seguidos');
    expect(notices[1]).toContain('baneo largo');
  });

  it('config inválida lanza error claro', async () => {
    const s = setup({ enabled: true, scan: { pagesPerRun: 0 } });
    await expect(runCycle(s.deps)).rejects.toThrow(/pagesPerRun/);
  });

  it('cycleMinutes: por defecto 60, validado 10-1440', () => {
    expect(cycleMinutesOf({})).toBe(60);
    expect(cycleMinutesOf({ scan: { cycleMinutes: 45 } })).toBe(45);
    expect(cycleMinutesOf({ scan: { cycleMinutes: 2 } })).toBe(60);
  });
});

describe('startPricewatchLoop', () => {
  it('programa el primer ciclo, reprograma según cycleMinutes, y stop() lo detiene', async () => {
    const s = setup(cfg({ scan: { enabled: false, cycleMinutes: 45 } }));
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const h = startPricewatchLoop({
      configPath: 'x',
      stateDir: 'y',
      log: s.deps.log,
      deps: s.deps,
      firstDelayMs: 1234,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return {
          clear: () => {
            t.cleared = true;
          },
        };
      },
    });
    expect(timers.map((t) => t.ms)).toEqual([1234]);
    timers[0]?.fn();
    await new Promise((r) => setTimeout(r, 20));
    expect(timers.map((t) => t.ms)).toEqual([1234, 45 * 60_000]);
    h.stop();
    expect(timers[1]?.cleared).toBe(true);
  });

  it('un error de config no mata el bucle y se reintenta', async () => {
    const s = setup({ enabled: true, scan: { pagesPerRun: 0 } });
    const timers: number[] = [];
    startPricewatchLoop({
      configPath: 'x',
      stateDir: 'y',
      log: s.deps.log,
      deps: s.deps,
      firstDelayMs: 1,
      setTimer: (fn, ms) => {
        timers.push(ms);
        if (timers.length === 1) setTimeout(fn, 0);
        return { clear: () => undefined };
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(timers).toEqual([1, 60 * 60_000]);
    expect(s.warns).toContain('pricewatch: ciclo fallido');
  });
});

describe('reintento con espera creciente', () => {
  it('un 403 cuenta como rechazo, no como pagina que no existe', () => {
    // The bug this prevents: a 403 read as "no cards" made the scanner report a store as
    // broken by JavaScript rendering, when the truth was that it refused the request.
    expect(BACKOFF_STATUS.has(403)).toBe(true);
    expect(BACKOFF_STATUS.has(429)).toBe(true);
    expect(BACKOFF_STATUS.has(503)).toBe(true);
    // A 404 is a real answer and must not be retried: the page is gone.
    expect(BACKOFF_STATUS.has(404)).toBe(false);
    expect(BACKOFF_STATUS.has(200)).toBe(false);
  });

  it('la espera crece entre intentos y se topa', async () => {
    const { backoffMs } = await import('../src/watch/pricewatch-runner.js');
    expect(backoffMs(1)).toBe(5_000);
    expect(backoffMs(2)).toBe(20_000);
    expect(backoffMs(3)).toBe(80_000);
    // Capped, or a stubborn store would hold the whole cycle for minutes.
    expect(backoffMs(4)).toBe(120_000);
    expect(backoffMs(9)).toBe(120_000);
  });
});

it('public reader upgrade retries no-card pauses once, without clearing real blocks/history/budget', () => {
  const db = new DatabaseSync(':memory:');
  const store = new PriceStore(db, () => 123456);
  store.setMeta('nocards_off:amazon:2026-10-07', 1);
  store.setMeta('nocards:amazon', 3);
  store.setMeta('reqs:www.amazon.es:2026-10-07', 169);
  store.setMeta('nocards_off:fnac:2026-10-07', 1);
  store.block('www.amazon.es');
  const until = store.blockedUntil('www.amazon.es');
  resetPublicReaderPause(store, '2026-10-07');
  expect(store.getMeta('nocards_off:amazon:2026-10-07')).toBe(0);
  expect(store.getMeta('nocards:amazon')).toBe(0);
  expect(store.getMeta('reqs:www.amazon.es:2026-10-07')).toBe(169);
  expect(store.getMeta('nocards_off:fnac:2026-10-07')).toBe(1);
  expect(store.blockedUntil('www.amazon.es')).toBe(until);
  store.setMeta('nocards_off:amazon:2026-10-07', 1);
  resetPublicReaderPause(store, '2026-10-07');
  expect(store.getMeta('nocards_off:amazon:2026-10-07')).toBe(1);
  db.close();
});
