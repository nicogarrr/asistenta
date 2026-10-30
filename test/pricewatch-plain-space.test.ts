import { describe, expect, it } from 'vitest';
import { extractCards } from '../src/watch/listscan.js';
import { amazonSelectorCents, parseEuroCents } from '../src/watch/pricewatch.js';

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
