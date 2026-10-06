import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  extractCards,
  isExcluded,
  type Listing,
  modelKey,
  pageUrl,
  parseScanConfig,
  scanOnce,
} from '../src/watch/listscan.js';
import { MIN_GAP_MS, PriceStore } from '../src/watch/pricewatch.js';

const DAY = 86_400_000;
const ldList = (items: { name: string; price: unknown; url: string; cur?: string }[]) =>
  `<script type="application/ld+json">${JSON.stringify({
    '@type': 'ItemList',
    itemListElement: items.map((x, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        name: x.name,
        url: x.url,
        offers: { '@type': 'Offer', price: x.price, priceCurrency: x.cur ?? 'EUR' },
      },
    })),
  })}</script>`;
const MM = 'https://www.mediamarkt.es/es/product/';

describe('tarjetas de listado', () => {
  it('lee ItemList de JSON-LD (precio numérico) y descarta no-EUR o URL de otro dominio', () => {
    const html = ldList([
      { name: 'TV Samsung TU65M73HAUXXC', price: 499, url: `${MM}a.html` },
      { name: 'Otra', price: 10, url: `${MM}b.html`, cur: 'USD' },
      { name: 'Ajena', price: 10, url: 'https://evil.example/x' },
      { name: 'Relativa', price: '99.90', url: '/es/product/c.html' },
    ]);
    const cards = extractCards('mediamarkt', html, 'https://www.mediamarkt.es/es/category/x.html');
    expect(cards.map((c) => [c.title, c.cents])).toEqual([
      ['TV Samsung TU65M73HAUXXC', 49900],
      ['Relativa', 9990],
    ]);
    expect(cards[1]?.url).toBe(`${MM}c.html`);
  });
  it('tarjeta sin precio o precio 0 se ignora; duplicados se unen', () => {
    const html = ldList([
      { name: 'A', price: 0, url: `${MM}a.html` },
      { name: 'B', price: 'abc', url: `${MM}b.html` },
      { name: 'C', price: 50, url: `${MM}c.html` },
      { name: 'C', price: 50, url: `${MM}c.html` },
    ]);
    expect(extractCards('mediamarkt', html, MM)).toHaveLength(1);
  });
  it('microdatos como respaldo', () => {
    const html = `<div itemtype="https://schema.org/Product"><span itemprop="name">Lavadora Bosch WGG244A0ES</span><meta itemprop="price" content="399.00"><a itemprop="url" href="https://www.worten.es/productos/x">v</a></div>`;
    expect(extractCards('worten', html, 'https://www.worten.es/')).toEqual([
      {
        title: 'Lavadora Bosch WGG244A0ES',
        url: 'https://www.worten.es/productos/x',
        cents: 39900,
      },
    ]);
  });
  it('Amazon: solo precio actual (no tachado), sin patrocinados', () => {
    const card = (asin: string, extra: string, price: string) =>
      `<div data-asin="${asin}" data-component-type="s-search-result" class="x"><h2 class="a"><a><span>Cafetera Delonghi ECAM29081</span></a></h2>${extra}<span class="a-price" data-a-size="xl"><span class="a-offscreen">${price}</span></span><span class="a-price a-text-price"><span class="a-offscreen">999,00 €</span></span></div>`;
    const html = card('B0CDCCZ9K8', '', '251,36 €') + card('B0BVBQYYFV', 'AdHolder', '1,00 €');
    const cards = extractCards('amazon', html, 'https://www.amazon.es/s?k=x');
    expect(cards).toEqual([
      {
        title: 'Cafetera Delonghi ECAM29081',
        url: 'https://www.amazon.es/dp/B0CDCCZ9K8',
        cents: 25136,
      },
    ]);
  });
});

describe('filtros y clave de modelo', () => {
  it('descarta accesorios, reacondicionados y packs, pero no "1 mando" de una consola', () => {
    expect(isExcluded('Funda para iPhone 18 Pro')).toBe(true);
    expect(isExcluded('Portátil HP reacondicionado')).toBe(true);
    expect(isExcluded('Pack de 3 filtros para cafetera')).toBe(true);
    expect(isExcluded('Mando para PS5')).toBe(true);
    expect(isExcluded('Consola Sony PS5 Slim, 825 GB, 4K, 1 mando')).toBe(false);
  });
  it('extrae el código de modelo y no confunde tamaños/capacidades', () => {
    expect(modelKey('TV LED 43" - Samsung TU43U8075HU, UHD 4K, 120Hz, 32GB')).toBe('m:tu43u8075hu');
    expect(modelKey('Samsung TU65M73HAUXXC TV Mini LED 65"')).toBe('m:tu65m73hauxxc');
    expect(modelKey('Smart TV 55 pulgadas 4K 120Hz')).toBeNull();
    expect(modelKey('A55 móvil')).toBeNull();
  });
});

describe('paginación y config', () => {
  const l = (store: Listing['store'], url: string): Listing => ({
    store,
    category: 'x',
    url,
    pages: 3,
  });
  it('solo pagina con patrón conocido', () => {
    expect(pageUrl(l('mediamarkt', 'https://www.mediamarkt.es/es/category/a.html'), 2)).toBe(
      'https://www.mediamarkt.es/es/category/a.html?page=2',
    );
    expect(pageUrl(l('elcorteingles', 'https://www.elcorteingles.es/electronica/tv/'), 2)).toBe(
      'https://www.elcorteingles.es/electronica/tv/2/',
    );
    expect(pageUrl(l('carrefour', 'https://www.carrefour.es/x/cat1/c'), 2)).toBeNull();
    expect(pageUrl(l('fnac', 'https://www.fnac.es/n1/x'), 1)).toBe('https://www.fnac.es/n1/x');
  });
  it('defaults desactivado y errores claros', () => {
    expect(parseScanConfig({}).enabled).toBe(false);
    expect(parseScanConfig({ scan: { enabled: true } })).toMatchObject({
      pagesPerRun: 5,
      dailyRequestsPerStore: 170,
    });
    expect(() => parseScanConfig({ scan: { pagesPerRun: 0 } })).toThrow(/pagesPerRun/);
    expect(() => parseScanConfig({ scan: { enabled: 'si' } })).toThrow(/enabled/);
    expect(() => parseScanConfig({ scan: { listings: [{ store: 'zara', url: 'x' }] } })).toThrow(
      /desconocida/,
    );
    expect(() =>
      parseScanConfig({ scan: { listings: [{ store: 'fnac', url: 'https://evil.example/' }] } }),
    ).toThrow(/no válida/);
  });
});

describe('scanOnce', () => {
  const LISTS: Listing[] = [
    {
      store: 'mediamarkt',
      category: 'tv',
      url: 'https://www.mediamarkt.es/es/category/tv.html',
      pages: 2,
    },
    {
      store: 'worten',
      category: 'tv',
      url: 'https://www.worten.es/productos/televisores',
      pages: 1,
    },
  ];
  const setup = (
    pages: Record<string, { status: number; html: string }>,
    over: Record<string, unknown> = {},
  ) => {
    let t = 10 * DAY;
    const sleeps: number[] = [];
    const sent: string[] = [];
    const fetched: string[] = [];
    const store = new PriceStore(new DatabaseSync(':memory:'), () => t);
    const deps = () => ({
      store,
      listings: LISTS,
      minDropPct: 70,
      pagesPerRun: 5,
      dailyCap: 170,
      maxCandidates: 10,
      gapMs: 1,
      now: () => t,
      random: () => 0,
      fetchPage: async (u: string) => {
        fetched.push(u);
        return pages[u] ?? { status: 404, html: '' };
      },
      robotsAllows: async () => true,
      sleep: async (ms: number) => void sleeps.push(ms),
      notify: async (x: string) => void sent.push(x),
      ...over,
    });
    return {
      store,
      deps,
      sleeps,
      sent,
      fetched,
      advance: (ms: number) => {
        t += ms;
      },
    };
  };
  const tv = (price: number) =>
    ldList([{ name: 'TV Samsung TU65M73HAUXXC 65"', price, url: `${MM}tv1.html` }]);

  it('candidato con referencia propia; el barato NO se guarda y no es candidato sin referencia', async () => {
    const t = setup({
      'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html: tv(15) },
    });
    const first = await scanOnce(t.deps());
    expect(first.candidates).toEqual([]);
    for (let i = 0; i < 5; i++) t.store.record('m:tu65m73hauxxc', 'mediamarkt', 50000);
    const r = await scanOnce(t.deps());
    expect(r.candidates).toHaveLength(0);
    // historia propia: 5 lecturas repartidas en 5 días
    const t2 = setup({
      'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html: tv(15) },
    });
    const db = new DatabaseSync(':memory:');
    const st = new PriceStore(db, () => 10 * DAY);
    db.exec('CREATE TABLE IF NOT EXISTS x(a)');
    for (let i = 0; i < 5; i++)
      db.prepare('INSERT INTO price_readings (product, store, ts, cents) VALUES (?,?,?,?)').run(
        'm:tu65m73hauxxc',
        'mediamarkt',
        10 * DAY - (5 - i) * DAY,
        50000,
      );
    const r2 = await scanOnce({ ...t2.deps(), store: st });
    expect(r2.candidates).toHaveLength(1);
    expect(r2.candidates[0]).toMatchObject({
      key: 'm:tu65m73hauxxc',
      store: 'mediamarkt',
      cents: 1500,
      dropPct: 97,
    });
    expect(st.history('m:tu65m73hauxxc', 'mediamarkt')).toHaveLength(5);
  });

  it('referencia cruzada con >= 2 otras tiendas', async () => {
    const t = setup({
      'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html: tv(100) },
    });
    t.store.record('m:tu65m73hauxxc', 'amazon', 50000);
    t.store.record('m:tu65m73hauxxc', 'fnac', 52000);
    const r = await scanOnce(t.deps());
    expect(r.candidates).toHaveLength(1);
    const one = setup({
      'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html: tv(100) },
    });
    one.store.record('m:tu65m73hauxxc', 'amazon', 50000);
    expect((await scanOnce(one.deps())).candidates).toHaveLength(0);
  });

  it('accesorios no cuentan; lectura normal se guarda una vez cada 3 h', async () => {
    const html = ldList([
      { name: 'Funda TV Samsung TU65M73HAUXXC', price: 5, url: `${MM}f.html` },
      { name: 'TV Samsung TU65M73HAUXXC 65"', price: 500, url: `${MM}tv1.html` },
    ]);
    const t = setup({ 'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html } });
    const a = await scanOnce({ ...t.deps(), listings: [LISTS[0] as Listing] });
    expect(a.cards).toBe(1);
    await scanOnce({ ...t.deps(), listings: [LISTS[0] as Listing] });
    expect(t.store.history('m:tu65m73hauxxc', 'mediamarkt')).toHaveLength(1);
    t.advance(4 * 3600 * 1000);
    await scanOnce({ ...t.deps(), listings: [LISTS[0] as Listing] });
    expect(t.store.history('m:tu65m73hauxxc', 'mediamarkt')).toHaveLength(2);
  });

  it('misma tienda: espera >= 30 s entre páginas (gap NaN cae al mínimo); cursor rota', async () => {
    const t = setup({}, { gapMs: Number.NaN, listings: [LISTS[0] as Listing], pagesPerRun: 2 });
    await scanOnce(t.deps());
    expect(t.sleeps).toEqual([MIN_GAP_MS]);
    expect(t.fetched).toEqual([
      'https://www.mediamarkt.es/es/category/tv.html',
      'https://www.mediamarkt.es/es/category/tv.html?page=2',
    ]);
    t.fetched.length = 0;
    await scanOnce({ ...t.deps(), pagesPerRun: 1 });
    expect(t.fetched).toEqual(['https://www.mediamarkt.es/es/category/tv.html']);
  });

  it('403/captcha bloquea solo esa tienda con backoff', async () => {
    const t = setup({
      'https://www.mediamarkt.es/es/category/tv.html': { status: 403, html: '' },
      'https://www.worten.es/productos/televisores': {
        status: 200,
        html: tv(500).replace('mediamarkt.es', 'worten.es'),
      },
    });
    const r = await scanOnce(t.deps());
    expect(r.blockedStores).toEqual(['www.mediamarkt.es']);
    expect(t.fetched).toHaveLength(2);
    expect(t.store.blockedUntil('www.mediamarkt.es')).toBe(10 * DAY + 60_000);
  });

  it('tope diario por tienda', async () => {
    const t = setup({}, { listings: [LISTS[0] as Listing], dailyCap: 10, pagesPerRun: 20 });
    await scanOnce(t.deps());
    expect(t.fetched).toHaveLength(2);
    const t3 = setup({}, { listings: [LISTS[0] as Listing], dailyCap: 10 });
    t3.store.setMeta('reqs:www.mediamarkt.es:1970-01-11', 10);
    const r = await scanOnce(t3.deps());
    expect(r.capped).toEqual(['MediaMarkt']);
    expect(t3.fetched).toHaveLength(0);
  });

  it('tienda sin tarjetas legibles: tras 3 páginas se pausa y se avisa una sola vez', async () => {
    const t = setup(
      {
        'https://www.worten.es/productos/televisores': {
          status: 200,
          html: '<html>sin datos</html>',
        },
      },
      { listings: [{ ...(LISTS[1] as Listing), pages: 1 }], pagesPerRun: 1 },
    );
    for (let i = 0; i < 5; i++) {
      await scanOnce(t.deps());
      t.advance(60_000);
    }
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain('Worten');
    expect(t.fetched).toHaveLength(3);
  });

  it('robots.txt prohibido: no se pide', async () => {
    const t = setup({}, { robotsAllows: async () => false });
    await scanOnce(t.deps());
    expect(t.fetched).toEqual([]);
  });

  it('candidato ya enviado a ficha: enfriamiento de 8 h', async () => {
    const t = setup(
      { 'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html: tv(100) } },
      { listings: [LISTS[0] as Listing], pagesPerRun: 1 },
    );
    t.store.record('m:tu65m73hauxxc', 'amazon', 50000);
    t.store.record('m:tu65m73hauxxc', 'fnac', 50000);
    expect((await scanOnce(t.deps())).candidates).toHaveLength(1);
    t.advance(MIN_GAP_MS);
    expect((await scanOnce(t.deps())).candidates).toHaveLength(0);
    t.advance(8 * 3600 * 1000);
    expect((await scanOnce(t.deps())).candidates).toHaveLength(1);
  });

  it('máximo de candidatos por pasada, los más baratos primero', async () => {
    const items = [1, 2, 3].map((i) => ({
      name: `TV Modelo ABC${i}000XYZ`,
      price: i * 10,
      url: `${MM}p${i}.html`,
    }));
    const t = setup(
      { 'https://www.mediamarkt.es/es/category/tv.html': { status: 200, html: ldList(items) } },
      { listings: [LISTS[0] as Listing], maxCandidates: 2 },
    );
    for (const i of [1, 2, 3]) {
      t.store.record(`m:abc${i}000xyz`, 'amazon', 50000);
      t.store.record(`m:abc${i}000xyz`, 'fnac', 50000);
    }
    const r = await scanOnce(t.deps());
    expect(r.candidates.map((c: { cents: number }) => c.cents)).toEqual([1000, 2000]);
  });
});
