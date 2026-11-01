import { describe, expect, it } from 'vitest';
import {
  COMPARE_GAP_MS,
  compareProduct,
  describeCompare,
  pickMatch,
  productIdentity,
  searchUrl,
  titleOverlap,
} from '../src/watch/compare.js';
import { STORES, type StoreId } from '../src/watch/price-extract.js';

const SEED_URL = 'https://www.amazon.es/dp/B0ABC12345';

function ficha(opts: {
  price: string;
  metaPrice?: string;
  ean?: string;
  name?: string;
  availability?: string;
}): string {
  const ean = opts.ean ? `"gtin13":"${opts.ean}",` : '';
  const meta = `<meta property="product:price:amount" content="${opts.metaPrice ?? opts.price}">`;
  return `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"${opts.name ?? 'Samsung TU65M73HAUXXC 65 pulgadas'}",${ean}"offers":{"@type":"Offer","priceCurrency":"EUR","price":"${opts.price}","availability":"${opts.availability ?? 'https://schema.org/InStock'}"}}</script>
${meta}
</head><body></body></html>`;
}

/** Búsqueda con una tarjeta JSON-LD (el camino de las tiendas no-Amazon). */
function searchWith(cards: { name: string; url: string; price: string }[]): string {
  const items = cards
    .map(
      (c) =>
        `{"@type":"Product","name":"${c.name}","url":"${c.url}","offers":{"@type":"Offer","priceCurrency":"EUR","price":"${c.price}"}}`,
    )
    .join(',');
  return `<html><head><script type="application/ld+json">[${items}]</script></head></html>`;
}

const MM_URL = 'https://www.mediamarkt.es/es/product/_samsung-tu65m73hauxxc-1234567.html';

/** fetchHtml stub: sirve la ficha semilla, búsquedas y fichas según la URL. */
function stubFetch(routes: Record<string, string>): (url: string) => Promise<string> {
  return async (url: string) => {
    for (const [prefix, html] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return html;
    }
    throw new Error(`404 ${url}`);
  };
}

const noSleep = async (): Promise<void> => {};

describe('productIdentity', () => {
  it('saca EAN, título y modelo del JSON-LD', () => {
    const id = productIdentity(ficha({ price: '899.99', ean: '8806094761234' }));
    expect(id.ean).toBe('8806094761234');
    expect(id.title).toBe('Samsung TU65M73HAUXXC 65 pulgadas');
    expect(id.model).toBe('m:tu65m73hauxxc');
  });

  it('cae al og:title cuando no hay JSON-LD', () => {
    const id = productIdentity(
      '<html><head><meta property="og:title" content="Tele X"></head></html>',
    );
    expect(id.title).toBe('Tele X');
    expect(id.ean).toBeNull();
  });
});

describe('searchUrl y titleOverlap', () => {
  it('genera búsquedas de las 7 tiendas', () => {
    for (const s of Object.keys(STORES) as StoreId[]) {
      expect(searchUrl(s, 'tele 65')).toContain(STORES[s].hosts[0] ?? '');
      expect(searchUrl(s, 'tele 65')).toContain('tele%2065');
    }
  });
  it('mide el solape de títulos', () => {
    expect(
      titleOverlap('Samsung TU65M73HAUXXC 65 pulgadas', 'TV Samsung TU65M73HAUXXC 65 pulgadas 4K'),
    ).toBeGreaterThanOrEqual(0.7);
    expect(titleOverlap('Samsung TU65M73HAUXXC', 'Funda para mando')).toBeLessThan(0.7);
  });
});

describe('pickMatch', () => {
  it('prefiere el mismo código de modelo al título parecido', () => {
    const cards = [
      { title: 'Televisor genérico 65 pulgadas', url: 'https://x.es/a', cents: 100 },
      { title: 'Samsung TU65M73HAUXXC Smart TV', url: 'https://x.es/b', cents: 200 },
    ];
    const picked = pickMatch(cards, {
      title: 'Samsung TU65M73HAUXXC 65',
      ean: null,
      model: 'm:tu65m73hauxxc',
    });
    expect(picked?.card.url).toBe('https://x.es/b');
    expect(picked?.match).toBe('modelo');
  });
});

describe('compareProduct', () => {
  it('compara las 7 tiendas, marca el mejor precio y cómo emparejó', async () => {
    const routes: Record<string, string> = {
      [SEED_URL]: ficha({ price: '999.99', ean: '8806094761234' }),
      'https://www.mediamarkt.es/es/search': searchWith([
        { name: 'Samsung TU65M73HAUXXC Smart TV 65', url: MM_URL, price: '899.99' },
      ]),
      [MM_URL]: ficha({
        price: '899.99',
        ean: '8806094761234',
        name: 'Samsung TU65M73HAUXXC Smart TV 65',
      }),
      'https://www.pccomponentes.com/search': searchWith([]),
      'https://www.carrefour.es/global/search': '<html>Introduce los caracteres</html>',
      'https://www.elcorteingles.es/search': searchWith([]),
      'https://www.fnac.es/SearchResult': searchWith([]),
      'https://www.worten.es/search': searchWith([]),
    };
    const report = await compareProduct(SEED_URL, {
      fetchHtml: stubFetch(routes),
      sleep: noSleep,
      now: () => Date.parse('2026-10-17T10:00:00Z'),
    });
    expect(report.rows).toHaveLength(7);
    const mm = report.rows.find((r) => r.store === 'mediamarkt');
    expect(mm).toMatchObject({ status: 'ok', cents: 89999, match: 'ean' });
    expect(report.best?.store).toBe('mediamarkt');
    const seed = report.rows.find((r) => r.store === 'amazon');
    expect(seed).toMatchObject({ status: 'ok', cents: 99999 });
    expect(report.rows.find((r) => r.store === 'carrefour')?.note).toContain('captcha');
    expect(report.rows.find((r) => r.store === 'fnac')?.status).toBe('no-encontrado');
    const text = describeCompare(report);
    expect(text).toContain('MEJOR PRECIO');
    expect(text).toContain('899,99 €');
    expect(text).toContain('mismo EAN');
    expect(text).toContain('no lo encuentro');
    expect(text).toContain('no se pudo comprobar (captcha');
  });

  it('un candidato con OTRO EAN no es el mismo producto', async () => {
    const routes: Record<string, string> = {
      [SEED_URL]: ficha({ price: '999.99', ean: '8806094761234' }),
      'https://www.mediamarkt.es/es/search': searchWith([
        { name: 'Samsung TU65M73HAUXXC Smart TV 65', url: MM_URL, price: '899.99' },
      ]),
      [MM_URL]: ficha({
        price: '899.99',
        ean: '1111111111111',
        name: 'Samsung TU65M73HAUXXC Smart TV 65',
      }),
    };
    const report = await compareProduct(SEED_URL, { fetchHtml: stubFetch(routes), sleep: noSleep });
    const mm = report.rows.find((r) => r.store === 'mediamarkt');
    expect(mm?.status).toBe('no-encontrado');
    expect(mm?.note).toContain('otro EAN');
  });

  it('fuentes que discrepan en la ficha: fila no fiable, sin precio inventado', async () => {
    const routes: Record<string, string> = {
      [SEED_URL]: ficha({ price: '999.99' }),
      'https://www.mediamarkt.es/es/search': searchWith([
        { name: 'Samsung TU65M73HAUXXC Smart TV 65', url: MM_URL, price: '899.99' },
      ]),
      [MM_URL]: ficha({
        price: '899.99',
        metaPrice: '1099.99',
        name: 'Samsung TU65M73HAUXXC Smart TV 65',
      }),
    };
    const report = await compareProduct(SEED_URL, { fetchHtml: stubFetch(routes), sleep: noSleep });
    const mm = report.rows.find((r) => r.store === 'mediamarkt');
    expect(mm?.status).toBe('no-fiable');
    expect(mm?.cents).toBeNull();
    expect(describeCompare(report)).toContain('precio no fiable');
  });

  it('una tienda caída no tumba la comparación', async () => {
    const report = await compareProduct(SEED_URL, {
      fetchHtml: stubFetch({ [SEED_URL]: ficha({ price: '999.99' }) }),
      sleep: noSleep,
    });
    expect(report.rows.find((r) => r.store === 'amazon')?.status).toBe('ok');
    expect(report.rows.filter((r) => r.status === 'error')).toHaveLength(6);
    expect(report.best?.store).toBe('amazon');
  });

  it('sin identidad aprovechable en la semilla: error claro', async () => {
    await expect(
      compareProduct(SEED_URL, {
        fetchHtml: async () => '<html><body></body></html>',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/qué producto es/);
  });

  it('respeta la pausa de cortesía entre peticiones', async () => {
    const waits: number[] = [];
    await compareProduct(SEED_URL, {
      fetchHtml: stubFetch({ [SEED_URL]: ficha({ price: '999.99' }) }),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits.length).toBeGreaterThanOrEqual(6);
    expect(waits.every((w) => w === COMPARE_GAP_MS)).toBe(true);
  });
});
