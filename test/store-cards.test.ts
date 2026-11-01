import { describe, expect, it } from 'vitest';
import { extractCards, modelKey } from '../src/watch/store-cards.js';

// Tarjetas de una página de resultados y clave de modelo (las usa /compara). Antes vivían en
// test/listscan.test.ts junto al barrido automático de listados, que se quitó.
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

describe('clave de modelo', () => {
  it('extrae el código de modelo y no confunde tamaños/capacidades', () => {
    expect(modelKey('TV LED 43" - Samsung TU43U8075HU, UHD 4K, 120Hz, 32GB')).toBe('m:tu43u8075hu');
    expect(modelKey('Samsung TU65M73HAUXXC TV Mini LED 65"')).toBe('m:tu65m73hauxxc');
    expect(modelKey('Smart TV 55 pulgadas 4K 120Hz')).toBeNull();
    expect(modelKey('A55 móvil')).toBeNull();
  });
});

describe('separadores dentro de codigos largos', () => {
  it('conserva la identidad exacta de un codigo separado por guion', () => {
    expect(modelKey('Samsung TU65-M73HAUXXC Mini LED')).toBe('m:tu65m73hauxxc');
    expect(modelKey('Samsung TU65‑M73HAUXXC Mini LED')).toBe('m:tu65m73hauxxc');
    expect(modelKey('Samsung TU65M73HAUXXC Mini LED')).toBe('m:tu65m73hauxxc');
    expect(modelKey('Samsung TU55-M73HAUXXC Mini LED')).toBe('m:tu55m73hauxxc');
  });
  it('no une capacidades, marcas, palabras ni modelos cortos', () => {
    expect(modelKey('Smart TV 55-120Hz 32GB')).toBeNull();
    expect(modelKey('A55 móvil')).toBeNull();
    expect(modelKey('Samsung-TU65M73HAUXXC')).toBe('m:tu65m73hauxxc');
    expect(modelKey('TU65-smart')).toBeNull();
  });
});

describe('identidad fragmentada falla cerrada', () => {
  it('no usa un sufijo compartido por dos tamaños con barra o espacio', () => {
    for (const size of ['55', '65']) {
      for (const separator of ['/', ' ']) {
        expect(modelKey(`Samsung TU${size}${separator}M73HAUXXC ${size} pulgadas`)).toBeNull();
      }
    }
  });
  it('no convierte sistema operativo y capacidad en codigo de modelo', () => {
    expect(modelKey('Samsung A55-Android14 128GB')).toBeNull();
    expect(modelKey('Samsung A55-Android14 256GB')).toBeNull();
  });
});
