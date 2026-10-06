import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AmazonStore,
  alertText,
  detect,
  extractPriceCents,
  isBlockedPage,
  MIN_GAP_MS,
  parseConfig,
  parseEuroCents,
  runOnce,
} from '../src/watch/amazon.js';

const DAY = 86_400_000;
const hist = (cents: number[], spanDays = 5, end = 10 * DAY) =>
  cents.map((c, i) => ({
    ts: end - spanDays * DAY + (i * spanDays * DAY) / (cents.length - 1),
    cents: c,
  }));

describe('parseo de precio', () => {
  it('lee euros con miles y céntimos', () => {
    expect(parseEuroCents('1.299,50 €')).toBe(129950);
    expect(parseEuroCents('12,3€')).toBe(1230);
    expect(parseEuroCents('sin precio')).toBeNull();
  });
  it('rechaza otros formatos en vez de adivinar', () => {
    expect(parseEuroCents('12.50 €')).toBeNull();
    expect(parseEuroCents('1,299.50 €')).toBeNull();
    expect(parseEuroCents('1.299.50 €')).toBeNull();
  });
  it('toma el primer a-offscreen y null si no hay', () => {
    expect(
      extractPriceCents(
        '<div id="corePrice_feature_div"><span class="a-offscreen">24,99 €</span></div>',
      ),
    ).toBe(2499);
    expect(extractPriceCents('<html>nada</html>')).toBeNull();
    // un a-offscreen fuera del bloque del precio principal (recomendados) no cuenta
    expect(extractPriceCents('<span class="a-offscreen">9,99 €</span>')).toBeNull();
  });
});

describe('detect', () => {
  const now = 10 * DAY;
  it('avisa con 60 % o más por debajo de la mediana', () => {
    const s = detect(3900, hist([10000, 10000, 9900, 10100, 10000]), now);
    expect(s?.reason).toBe('caida');
    expect(s?.medianCents).toBe(10000);
  });
  it('no avisa con 59 % por debajo', () => {
    expect(detect(4100, hist([10000, 10000, 10000, 10000, 10000]), now)).toBeNull();
  });
  it('avisa <= 15 EUR con mediana >= 100 EUR', () => {
    expect(detect(1500, hist([12000, 12000, 12000, 12000, 12000]), now)?.reason).toBe('caida');
  });
  it('caso absoluto sin caída del 60 %: 15 EUR con mediana 100 EUR es 85 %, cae por caida; 15 EUR / 30 EUR no avisa', () => {
    expect(detect(1500, hist([3000, 3000, 3000, 3000, 3000]), now)).toBeNull();
  });
  it('calla con menos de 5 lecturas o menos de 3 días', () => {
    expect(detect(100, hist([10000, 10000, 10000, 10000]), now)).toBeNull();
    expect(detect(100, hist([10000, 10000, 10000, 10000, 10000], 2), now)).toBeNull();
  });
  it('el texto dice sospecha y da la base', () => {
    const s = detect(3000, hist([10000, 10000, 10000, 10000, 10000]), now);
    if (!s) throw new Error('sin sospecha');
    const t = alertText('B012345678', s);
    expect(t).toContain('Posible error de precio');
    expect(t).toContain('5 lecturas en 5 días');
    expect(t).toContain('https://www.amazon.es/dp/B012345678');
  });
});

describe('bloqueo', () => {
  it('reconoce captcha y 429/503', () => {
    expect(isBlockedPage(200, '<form action="/errors/validateCaptcha">')).toBe(true);
    expect(isBlockedPage(503, '')).toBe(true);
    expect(
      isBlockedPage(
        200,
        '<div id="corePrice_feature_div"><span class="a-offscreen">1,00 €</span></div>',
      ),
    ).toBe(false);
  });
});

describe('runOnce', () => {
  const setup = (pages: Record<string, { status: number; html: string }>) => {
    let t = 10 * DAY;
    const sleeps: number[] = [];
    const sent: string[] = [];
    const store = new AmazonStore(new DatabaseSync(':memory:'), () => t);
    const deps = (asins: string[], gapMs = 1) => ({
      store,
      asins,
      gapMs,
      now: () => t,
      fetchPage: async (u: string) => pages[u.split('/dp/')[1] ?? ''] ?? { status: 404, html: '' },
      sleep: async (ms: number) => void sleeps.push(ms),
      notify: async (x: string) => void sent.push(x),
    });
    return {
      store,
      deps,
      sleeps,
      sent,
      setNow: (x: number) => {
        t = x;
      },
    };
  };
  const page = (eurText: string) => ({
    status: 200,
    html: `<div id="corePrice_feature_div"><span class="a-offscreen">${eurText}</span></div>`,
  });

  it('fuerza 30 s entre páginas aunque la config pida menos, e ignora ASIN inválidos', async () => {
    const { deps, sleeps } = setup({ B000000001: page('10,00 €'), B000000002: page('10,00 €') });
    const r = await runOnce(deps(['B000000001', 'mal', 'B000000002'], 1));
    expect(r.checked).toBe(2);
    expect(sleeps).toEqual([MIN_GAP_MS]);
  });

  it('con captcha para la pasada, bloquea y no pide más páginas', async () => {
    const { deps, store, sleeps } = setup({
      B000000001: { status: 200, html: '/errors/validateCaptcha' },
      B000000002: page('10,00 €'),
    });
    const r = await runOnce(deps(['B000000001', 'B000000002']));
    expect(r.stopped).toBe('blocked');
    expect(sleeps).toEqual([]);
    expect(store.blockedUntil()).toBeGreaterThan(10 * DAY);
    expect((await runOnce(deps(['B000000002']))).stopped).toBe('already-blocked');
  });

  it('historia suficiente y caída: una alerta, y no repite en 24 h', async () => {
    const { deps, store, sent, setNow } = setup({ B000000001: page('30,00 €') });
    for (let i = 0; i < 5; i++) {
      setNow(5 * DAY + i * DAY);
      store.record('B000000001', 10000);
    }
    setNow(10 * DAY);
    const r1 = await runOnce(deps(['B000000001']));
    expect(r1.alerts).toBe(1);
    expect(sent).toHaveLength(1);
    const r2 = await runOnce(deps(['B000000001']));
    expect(r2.alerts).toBe(0);
  });

  it('una página sin precio legible es fallo, no lectura de 0', async () => {
    const { deps, store } = setup({ B000000001: { status: 200, html: '<html>sin precio</html>' } });
    const r = await runOnce(deps(['B000000001']));
    expect(r.failures).toBe(1);
    expect(store.history('B000000001')).toEqual([]);
  });

  it('sin historia no avisa aunque el precio sea ridículo', async () => {
    const { deps, sent } = setup({ B000000001: page('1,00 €') });
    await runOnce(deps(['B000000001']));
    expect(sent).toEqual([]);
  });

  it('gapMs no numérico cae al mínimo de 30 s, no a 0', async () => {
    const { deps, sleeps } = setup({ B000000001: page('10,00 €'), B000000002: page('10,00 €') });
    await runOnce(deps(['B000000001', 'B000000002'], Number.NaN));
    expect(sleeps).toEqual([MIN_GAP_MS]);
  });

  it('avisa una vez tras 3 pasadas seguidas sin ninguna lectura', async () => {
    const { deps, sent } = setup({ B000000001: { status: 200, html: '<html>sin precio</html>' } });
    for (let i = 0; i < 4; i++) await runOnce(deps(['B000000001']));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('3 pasadas seguidas');
  });
});

describe('parseConfig', () => {
  it('aplica valores por defecto y solo enabled=true activa', () => {
    const c = parseConfig({ enabled: true, asins: ['B000000001'] });
    expect(c.enabled).toBe(true);
    expect(c.gapMs).toBe(30_000);
    expect(c.telegram.enabled).toBe(false);
    expect(parseConfig({}).enabled).toBe(false);
  });
  it('rechaza tipos erróneos en vez de degradar en silencio', () => {
    expect(() => parseConfig({ enabled: 'yes' })).toThrow(/enabled/);
    expect(() => parseConfig({ asins: 'B000000001' })).toThrow(/asins/);
    expect(() => parseConfig({ asins: [1] })).toThrow(/asins/);
    expect(() => parseConfig({ gapSeconds: 'rápido' })).toThrow(/gapSeconds/);
    expect(() => parseConfig({ gapSeconds: -5 })).toThrow(/gapSeconds/);
    expect(() => parseConfig({ telegram: { chatId: 123 } })).toThrow(/chatId/);
    expect(() => parseConfig([])).toThrow(/objeto/);
  });
});
