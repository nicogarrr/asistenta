import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  alertText,
  detect,
  extractReading,
  isBlockedPage,
  MIN_GAP_MS,
  PriceStore,
  parseConfig,
  parseEuroCents,
  parseMachinePrice,
  referenceFor,
  robotsDisallows,
  runOnce,
  toUrl,
} from '../src/watch/pricewatch.js';

const DAY = 86_400_000;
const hist = (cents: number[], spanDays = 5, end = 10 * DAY) =>
  cents.map((c, i) => ({
    ts: end - spanDays * DAY + (i * spanDays * DAY) / (cents.length - 1),
    cents: c,
  }));
const ld = (offer: string) =>
  `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X","offers":${offer}}</script>`;

describe('parseo de precio', () => {
  it('lee euros españoles y el punto decimal sin ambigüedad', () => {
    expect(parseEuroCents('1.299,50 €')).toBe(129950);
    expect(parseEuroCents('12,3€')).toBe(1230);
    // El punto con 1-2 cifras detrás solo puede ser decimal (antes daba null).
    expect(parseEuroCents('12.50 €')).toBe(1250);
    expect(parseEuroCents('1,299.50 €')).toBe(129950);
    expect(parseEuroCents('1,299 €')).toBeNull();
    expect(parseEuroCents('sin precio')).toBeNull();
  });
  it('miles separados por espacio (normal, duro, estrecho o fino) no pierden los miles', () => {
    expect(parseEuroCents('1\u202f299,00\u00a0€')).toBe(129900);
    expect(parseEuroCents('1\u2009299,00 €')).toBe(129900);
    expect(parseEuroCents('1\u00a0299,99 €')).toBe(129999);
    // Espacio normal: solo en fuentes con un único precio (opción explícita).
    expect(parseEuroCents('Portátil 1 299,00 €', { plainSpaceThousands: true })).toBe(129900);
    expect(parseEuroCents('12 345 678 €', { plainSpaceThousands: true })).toBe(1234567800);
    expect(parseEuroCents('Portátil 1 299,00 €')).toBeNull();
    expect(parseEuroCents('Precio 299,00 €')).toBe(29900);
    expect(
      parseEuroCents(
        new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(1299),
      ),
    ).toBe(129900);
  });
  it('lee precios de máquina (JSON-LD y metaetiquetas)', () => {
    expect(parseMachinePrice('1299.99')).toBe(129999);
    expect(parseMachinePrice(549.99)).toBe(54999);
    expect(parseMachinePrice('1.299,00')).toBe(129900);
    expect(parseMachinePrice('abc')).toBeNull();
    expect(parseMachinePrice(0)).toBeNull();
  });
});

describe('extractReading', () => {
  it('JSON-LD con Offer, EUR y stock', () => {
    const r = extractReading(
      'mediamarkt',
      ld(
        '{"@type":"Offer","price":"549.99","priceCurrency":"EUR","availability":"https://schema.org/InStock"}',
      ),
    );
    expect(r).toMatchObject({ cents: 54999, inStock: true, reliable: true });
  });
  it('ignora otra moneda y marca agotado', () => {
    expect(
      extractReading('fnac', ld('{"@type":"Offer","price":"10","priceCurrency":"USD"}')).cents,
    ).toBeNull();
    const r = extractReading(
      'fnac',
      ld('[{"@type":"Offer","price":10,"priceCurrency":"EUR","availability":"OutOfStock"}]'),
    );
    expect(r.inStock).toBe(false);
  });
  it('lee Offer anidado en BuyAction (MediaMarkt) y AggregateOffer', () => {
    const html = `<script type="application/ld+json">{"@type":"BuyAction","object":{"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":"99.5","priceCurrency":"EUR","offerCount":1}}}</script>`;
    expect(extractReading('mediamarkt', html).cents).toBe(9950);
  });
  it('AggregateOffer: lowPrice solo con un único vendedor (offerCount 1)', () => {
    const agg = (extra: string) =>
      `<script type="application/ld+json">{"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":"99.5","priceCurrency":"EUR"${extra}}}</script>`;
    expect(extractReading('mediamarkt', agg('')).cents).toBeNull();
    expect(extractReading('mediamarkt', agg(',"offerCount":3')).cents).toBeNull();
    expect(extractReading('mediamarkt', agg(',"offerCount":1')).cents).toBe(9950);
  });
  it('JSON-LD roto se ignora; meta y microdatos sirven de respaldo', () => {
    const html = `<script type="application/ld+json">{roto</script><meta property="product:price:amount" content="79.90">`;
    expect(extractReading('worten', html)).toMatchObject({ cents: 7990, reliable: true });
    expect(extractReading('worten', '<span itemprop="price" content="12.00"></span>').cents).toBe(
      1200,
    );
  });
  it('dos fuentes que discrepan = no fiable', () => {
    const html = `${ld('{"@type":"Offer","price":"100.00","priceCurrency":"EUR"}')}<meta property="og:price:amount" content="10.00">`;
    const r = extractReading('carrefour', html);
    expect(r.reliable).toBe(false);
    expect(r.sources).toHaveLength(2);
  });
  it('dos fuentes que coinciden = fiable', () => {
    const html = `${ld('{"@type":"Offer","price":"100.00","priceCurrency":"EUR"}')}<meta property="og:price:amount" content="100.50">`;
    expect(extractReading('carrefour', html).reliable).toBe(true);
  });
  it('Amazon: solo el bloque del precio principal, y stock', () => {
    const block = '<div id="corePrice_feature_div"><span class="a-offscreen">24,99 €</span></div>';
    expect(
      extractReading('amazon', `${block}<div id="availability"><span>En stock</span></div>`),
    ).toMatchObject({
      cents: 2499,
      inStock: true,
    });
    expect(extractReading('amazon', '<span class="a-offscreen">9,99 €</span>').cents).toBeNull();
  });
  it('la ficha real de MediaMarkt (fixture) se lee', () => {
    const html = readFileSync(new URL('./fixtures/mediamarkt-ld.html', import.meta.url), 'utf8');
    const r = extractReading('mediamarkt', html);
    expect(r.cents).not.toBeNull();
    expect(r.reliable).toBe(true);
  });
});

describe('bloqueo y robots', () => {
  it('reconoce captcha, Cloudflare y 403/429/503', () => {
    expect(isBlockedPage(200, '<form action="/errors/validateCaptcha">')).toBe(true);
    expect(isBlockedPage(200, '<title>Just a moment...</title>')).toBe(true);
    expect(isBlockedPage(403, '')).toBe(true);
    expect(isBlockedPage(503, '')).toBe(true);
    expect(isBlockedPage(200, ld('{"@type":"Offer","price":"1"}'))).toBe(false);
  });
  it('robots.txt: Disallow del grupo * y Allow más largo', () => {
    const txt =
      'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart\nDisallow: /p/\nAllow: /p/ok';
    expect(robotsDisallows(txt, '/cart/1')).toBe(true);
    expect(robotsDisallows(txt, '/p/xx')).toBe(true);
    expect(robotsDisallows(txt, '/p/ok/1')).toBe(false);
    expect(robotsDisallows(txt, '/dp/B0')).toBe(false);
    expect(robotsDisallows('', '/x')).toBe(false);
  });
});

describe('referencia y detección', () => {
  const now = 10 * DAY;
  it('mediana propia con >= 5 lecturas en >= 3 días', () => {
    const ref = referenceFor(hist([10000, 10000, 9900, 10100, 10000]), now, []);
    expect(ref).toMatchObject({ cents: 10000, kind: 'propia' });
  });
  it('sin historia, mediana de >= 2 otras tiendas; con 1 sola, nada', () => {
    const ref = referenceFor([], now, [
      { store: 'amazon', cents: 10000 },
      { store: 'worten', cents: 11000 },
    ]);
    expect(ref).toMatchObject({ cents: 10500, kind: 'cruzada' });
    expect(referenceFor([], now, [{ store: 'amazon', cents: 10000 }])).toBeNull();
    expect(referenceFor(hist([1, 1, 1, 1, 1], 2), now, [])).toBeNull();
  });
  it('umbral minDropPct exacto', () => {
    const ref = { cents: 10000, kind: 'propia' as const, detail: 'x' };
    expect(detect(3000, ref, 70)?.dropPct).toBe(70);
    expect(detect(3100, ref, 70)).toBeNull();
    expect(detect(1, null, 70)).toBeNull();
  });
  it('el texto dice sospecha, origen de la referencia, stock y enlace', () => {
    const s = detect(
      2000,
      { cents: 10000, kind: 'cruzada', detail: 'mediana de Amazon.es, Worten' },
      70,
    );
    if (!s) throw new Error('sin sospecha');
    const t = alertText(
      'AirPods',
      'mediamarkt',
      'https://www.mediamarkt.es/x',
      s,
      true,
      new Date(10 * DAY),
    );
    expect(t).toContain('Posible error de precio');
    expect(t).toContain('MediaMarkt: 20,00 € (80 % menos que la referencia)');
    expect(t).toContain('Referencia en otras tiendas: 100,00 €');
    expect(t).not.toContain('bajó de');
    expect(t).not.toContain('Precio habitual observado');
    expect(t).toContain('cruzada');
    expect(t).toContain('en stock');
    expect(t).toContain('https://www.mediamarkt.es/x');
  });
});

describe('precio habitual observado', () => {
  it('identifica la mediana propia sin presentarla como precio previo', () => {
    const s = detect(
      2000,
      { cents: 10000, kind: 'propia', detail: 'mediana de 5 lecturas en 3 días' },
      70,
    );
    if (!s) throw new Error('sin sospecha');
    const t = alertText(
      'Producto',
      'mediamarkt',
      'https://www.mediamarkt.es/x',
      s,
      null,
      new Date(10 * DAY),
    );
    expect(t).toContain('Precio habitual observado: 100,00 €');
    expect(t).toContain('mediana de 5 lecturas en 3 días');
    expect(t).not.toContain('bajó de');
    expect(t).not.toContain('Referencia en otras tiendas');
  });
});

describe('toUrl y parseConfig', () => {
  it('valida ASIN y URLs por tienda', () => {
    expect(toUrl('amazon', 'B0FQF32239')).toBe('https://www.amazon.es/dp/B0FQF32239');
    expect(toUrl('mediamarkt', 'https://www.mediamarkt.es/es/product/x.html')).not.toBeNull();
    expect(toUrl('mediamarkt', 'https://evil.example/mediamarkt.es')).toBeNull();
    expect(toUrl('mediamarkt', 'http://www.mediamarkt.es/x')).toBeNull();
    expect(toUrl('fnac', 'B0FQF32239')).toBeNull();
  });
  it('defaults y errores claros', () => {
    const c = parseConfig({
      enabled: true,
      products: [{ name: 'A', urls: { amazon: 'B0FQF32239' } }],
    });
    expect(c).toMatchObject({ enabled: true, gapMs: 30_000, minDropPct: 70 });
    expect(parseConfig({}).enabled).toBe(false);
    expect(() => parseConfig({ enabled: 'si' })).toThrow(/enabled/);
    expect(() => parseConfig({ gapSeconds: 'x' })).toThrow(/gapSeconds/);
    expect(() => parseConfig({ minDropPct: 5 })).toThrow(/minDropPct/);
    expect(() => parseConfig({ products: 'x' })).toThrow(/products/);
    expect(() => parseConfig({ products: [{ urls: {} }] })).toThrow(/name/);
    expect(() => parseConfig({ products: [{ name: 'A', urls: { zara: 'x' } }] })).toThrow(
      /desconocida/,
    );
    expect(() => parseConfig({ products: [{ name: 'A', urls: { amazon: 'nope' } }] })).toThrow(
      /no válida/,
    );
    expect(() => parseConfig({ telegram: { chatId: 1 } })).toThrow(/chatId/);
  });
});

describe('runOnce', () => {
  const page = (price: string, stock = 'InStock') => ({
    status: 200,
    html: ld(
      `{"@type":"Offer","price":"${price}","priceCurrency":"EUR","availability":"https://schema.org/${stock}"}`,
    ),
  });
  const URLS = {
    amazon: 'https://www.amazon.es/dp/B000000001',
    mediamarkt: 'https://www.mediamarkt.es/es/product/a.html',
    worten: 'https://www.worten.es/produtos/a',
  };
  const setup = (
    pages: Record<string, { status: number; html: string }>,
    urls: Partial<Record<string, string>> = URLS,
  ) => {
    let t = 10 * DAY;
    const sleeps: number[] = [];
    const sent: string[] = [];
    const fetched: string[] = [];
    const store = new PriceStore(new DatabaseSync(':memory:'), () => t);
    const deps = (over: Partial<Parameters<typeof runOnce>[0]> = {}) => ({
      store,
      products: [{ name: 'TV', urls }],
      gapMs: 1,
      minDropPct: 70,
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
      setNow: (x: number) => {
        t = x;
      },
    };
  };

  it('misma tienda: espera >= 30 s aunque la config pida menos; tiendas distintas no esperan', async () => {
    const pages = { [URLS.amazon]: page('100.00'), [URLS.mediamarkt]: page('100.00') };
    const a = setup(pages, { amazon: URLS.amazon, mediamarkt: URLS.mediamarkt });
    await runOnce(a.deps());
    expect(a.sleeps).toEqual([]);
    const b = setup({ [URLS.amazon]: page('100.00') });
    await runOnce({
      ...b.deps(),
      products: [
        { name: 'A', urls: { amazon: URLS.amazon } },
        { name: 'B', urls: { amazon: URLS.amazon } },
      ],
    });
    expect(b.sleeps).toEqual([MIN_GAP_MS]);
  });

  it('gapMs no numérico cae al mínimo y el jitter solo alarga', async () => {
    const b = setup({ [URLS.amazon]: page('100.00') });
    await runOnce({
      ...b.deps({ gapMs: Number.NaN, random: () => 1 }),
      products: [
        { name: 'A', urls: { amazon: URLS.amazon } },
        { name: 'B', urls: { amazon: URLS.amazon } },
      ],
    });
    expect(b.sleeps).toEqual([MIN_GAP_MS * 1.2]);
  });

  it('403/captcha bloquea SOLO esa tienda con backoff creciente; las demás siguen', async () => {
    const t = setup({
      [URLS.amazon]: { status: 403, html: '' },
      [URLS.mediamarkt]: page('100.00'),
    });
    const r = await runOnce(t.deps());
    expect(r.blockedStores).toEqual(['www.amazon.es']);
    expect(r.checked).toBe(1);
    expect(t.store.blockedUntil('www.amazon.es')).toBe(10 * DAY + 60_000);
    t.setNow(10 * DAY + 2 * 60_000);
    await runOnce(t.deps());
    expect(t.store.blockedUntil('www.amazon.es')).toBe(10 * DAY + 2 * 60_000 + 5 * 60_000);
  });

  it('dailyCap: las fichas cuentan en el tope diario del host y se salta al llegar', async () => {
    const t = setup({ [URLS.amazon]: page('100.00') });
    await runOnce({
      ...t.deps(),
      dailyCap: 2,
      products: [
        { name: 'A', urls: { amazon: URLS.amazon } },
        { name: 'B', urls: { amazon: URLS.amazon } },
        { name: 'C', urls: { amazon: URLS.amazon } },
      ],
    });
    expect(t.fetched).toHaveLength(2);
    expect(t.store.getMeta('reqs:www.amazon.es:1970-01-11')).toBe(2);
    const free = setup({ [URLS.amazon]: page('100.00') });
    await runOnce({
      ...free.deps(),
      products: [
        { name: 'A', urls: { amazon: URLS.amazon } },
        { name: 'B', urls: { amazon: URLS.amazon } },
        { name: 'C', urls: { amazon: URLS.amazon } },
      ],
    });
    expect(free.fetched).toHaveLength(3);
  });

  it('robots.txt prohibido: no se lee', async () => {
    const t = setup({ [URLS.amazon]: page('100.00') });
    const r = await runOnce(t.deps({ robotsAllows: async () => false }));
    expect(t.fetched).toEqual([]);
    expect(r.skipped).toBe(3);
  });

  it('referencia cruzada: precio -80% frente a otras 2 tiendas avisa tras releer', async () => {
    const t = setup({
      [URLS.amazon]: page('20.00'),
      [URLS.mediamarkt]: page('100.00'),
      [URLS.worten]: page('110.00'),
    });
    t.store.record('TV', 'mediamarkt', 10000);
    t.store.record('TV', 'worten', 11000);
    const r = await runOnce(t.deps());
    expect(r.alerts).toBe(1);
    expect(t.sent[0]).toContain('Amazon.es: 20,00 €');
    expect(t.fetched.filter((u) => u === URLS.amazon)).toHaveLength(2);
    expect(t.sleeps).toContain(MIN_GAP_MS);
    expect(t.store.history('TV', 'amazon')).toEqual([]);
    const again = await runOnce(t.deps());
    expect(again.alerts).toBe(0);
  });

  it('no avisa si la relectura ya no está barata, ni agotado, ni lectura no fiable', async () => {
    let n = 0;
    const flaky = setup({});
    flaky.store.record('TV', 'mediamarkt', 10000);
    flaky.store.record('TV', 'worten', 11000);
    const r1 = await runOnce(
      flaky.deps({ fetchPage: async () => (n++ === 0 ? page('20.00') : page('100.00')) }),
    );
    expect(r1.alerts).toBe(0);

    const oos = setup({ [URLS.amazon]: page('20.00', 'OutOfStock') });
    oos.store.record('TV', 'mediamarkt', 10000);
    oos.store.record('TV', 'worten', 11000);
    expect((await runOnce(oos.deps())).alerts).toBe(0);

    const bad = setup({
      [URLS.amazon]: {
        status: 200,
        html: `${ld('{"@type":"Offer","price":"20.00","priceCurrency":"EUR"}')}<meta property="og:price:amount" content="100.00">`,
      },
    });
    bad.store.record('TV', 'mediamarkt', 10000);
    bad.store.record('TV', 'worten', 11000);
    const r3 = await runOnce(bad.deps());
    expect(r3.alerts).toBe(0);
    expect(r3.failures).toBeGreaterThanOrEqual(1);
  });

  it('sin referencia no avisa aunque el precio sea ridículo; página sin precio es fallo', async () => {
    const t = setup({
      [URLS.amazon]: page('1.00'),
      [URLS.mediamarkt]: { status: 200, html: '<html>nada</html>' },
    });
    const r = await runOnce(t.deps());
    expect(r.alerts).toBe(0);
    expect(r.failures).toBeGreaterThanOrEqual(1);
    expect(t.store.history('TV', 'mediamarkt')).toEqual([]);
  });

  it('avisa una vez tras 3 pasadas seguidas sin lecturas', async () => {
    const t = setup({});
    for (let i = 0; i < 4; i++) await runOnce(t.deps());
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain('3 pasadas seguidas');
  });
});
