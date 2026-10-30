import { describe, expect, it } from 'vitest';
import { extractPriceTexts, findTotalPrice, parsePriceToCents } from '../src/tools/checkout.js';

// Intl.NumberFormat('fr-FR') y muchas tiendas europeas separan los miles con un
// espacio fino sin salto (U+202F) o un espacio fino (U+2009). El parser solo conocía
// el espacio normal y el U+00A0: «€1 299» se leía como 1 € y pasaba el tope.
const NNBSP = '\u202f';
const THIN = '\u2009';

describe('checkout: miles separados con espacio fino (U+202F / U+2009)', () => {
  it('«Total: €1 299» no se lee como 1 €', () => {
    const total = findTotalPrice(`Total: €1${NNBSP}299`);
    expect(total).not.toBeNull();
    expect(parsePriceToCents(total?.raw ?? '')).toBe(129900);
  });

  it('formato francés de Intl («1 299,00 €») se lee entero', () => {
    const fr = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(1299);
    const total = findTotalPrice(`Total : ${fr}`);
    expect(parsePriceToCents(total?.raw ?? '')).toBe(129900);
  });

  for (const sep of [NNBSP, THIN]) {
    it(`extractPriceTexts no recorta «1${sep === NNBSP ? 'U+202F' : 'U+2009'}299,00 €» a 299`, () => {
      const prices = extractPriceTexts(`Portátil 1${sep}299,00 €`);
      expect(prices.map((p) => parsePriceToCents(p.raw))).toEqual([129900]);
    });
  }

  it('un número seguido de espacio y más cifras no se toma truncado tras el símbolo', () => {
    // «€1 29» no es un importe válido: mejor ninguno que «1 €».
    expect(findTotalPrice(`Total: €1${NNBSP}29`)).toBeNull();
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(findTotalPrice('Total: 1.234,56 €')?.raw).toBe('1.234,56');
    expect(findTotalPrice('Total: 1\u00a0299,00\u00a0€')?.raw).toBe('1299,00');
    expect(findTotalPrice('Total: 45,20 €. Gracias')?.raw).toBe('45,20');
    expect(findTotalPrice('Total: €29.99')).toBeNull();
  });
});
