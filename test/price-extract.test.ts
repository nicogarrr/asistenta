import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  amazonSelectorCents,
  extractReading,
  isBlockedPage,
  parseEuroCents,
  parseMachinePrice,
  toUrl,
} from '../src/watch/price-extract.js';
import { extractCards } from '../src/watch/store-cards.js';

// Lectura de precio de una ficha (la usan «vigila este enlace» y /compara). Antes vivía en
// test/pricewatch.test.ts junto al barrido automático de tiendas, que se quitó.

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

describe('bloqueo', () => {
  it('reconoce captcha, Cloudflare y 403/429/503', () => {
    expect(isBlockedPage(200, '<form action="/errors/validateCaptcha">')).toBe(true);
    expect(isBlockedPage(200, '<title>Just a moment...</title>')).toBe(true);
    expect(isBlockedPage(403, '')).toBe(true);
    expect(isBlockedPage(503, '')).toBe(true);
    expect(isBlockedPage(200, ld('{"@type":"Offer","price":"1"}'))).toBe(false);
  });
});

describe('toUrl', () => {
  it('valida ASIN y URLs por tienda', () => {
    expect(toUrl('amazon', 'B0FQF32239')).toBe('https://www.amazon.es/dp/B0FQF32239');
    expect(toUrl('mediamarkt', 'https://www.mediamarkt.es/es/product/x.html')).not.toBeNull();
    expect(toUrl('mediamarkt', 'https://evil.example/mediamarkt.es')).toBeNull();
    expect(toUrl('mediamarkt', 'http://www.mediamarkt.es/x')).toBeNull();
    expect(toUrl('fnac', 'B0FQF32239')).toBeNull();
  });
});

describe('parseEuroCents: espacio normal entre cifras', () => {
  it('«talla 42 199 €» no son 42199 € en texto libre', () => {
    expect(parseEuroCents('talla 42 199 €')).toBeNull();
    expect(parseEuroCents('Zapatilla talla 42 199,95 €')).toBeNull();
  });

  it('sin la opción, «1 299,00 €» con espacio normal no se lee como 299 €', () => {
    expect(parseEuroCents('1 299,00 €')).toBeNull();
  });

  it('los demás formatos siguen igual', () => {
    expect(parseEuroCents('Precio 199 €')).toBe(19900);
    expect(parseEuroCents('1.299,50 €')).toBe(129950);
    expect(parseEuroCents('1\u00a0299,00\u00a0€')).toBe(129900);
    expect(parseEuroCents('1\u202f299,00 €')).toBe(129900);
    expect(parseEuroCents('12,34€')).toBe(1234);
  });

  it('con plainSpaceThousands (fuente con solo el precio) «1 299,00 €» son 1299 €', () => {
    expect(parseEuroCents('1 299,00 €', { plainSpaceThousands: true })).toBe(129900);
    expect(parseEuroCents('42 199 €', { plainSpaceThousands: true })).toBe(4219900);
  });

  it('Amazon: el a-offscreen con espacio normal o duro sigue leyendo 1299 €', () => {
    for (const p of ['1 299,00 €', '1\u00a0299,00\u00a0€']) {
      const html = `<div data-asin="B000000001" data-component-type="s-search-result"><h2><span>Portátil X</span></h2><span class="a-price"><span class="a-offscreen">${p}</span></span></div>`;
      expect(extractCards('amazon', html, 'https://www.amazon.es').map((c) => c.cents)).toEqual([
        129900,
      ]);
      expect(
        amazonSelectorCents(
          `<div id="corePrice_feature_div"><span class="a-offscreen">${p}</span></div>`,
        ),
      ).toBe(129900);
    }
  });
});
