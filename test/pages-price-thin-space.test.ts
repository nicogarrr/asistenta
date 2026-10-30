import { describe, expect, it } from 'vitest';
import { extractPrice } from '../src/watch/pages.js';

describe('vigilancia de páginas: precio con espacio entre miles', () => {
  for (const sep of ['\u00a0', '\u202f', '\u2009']) {
    const cp = sep.codePointAt(0)?.toString(16);
    it(`«1${cp}299,00 €» son 1299 €, no 299 €`, () => {
      expect(extractPrice(`Ahora 1${sep}299,00${sep}€ IVA incl.`)).toBe('1299,00 €');
      expect(extractPrice(`Precio: 12${sep}345 €`)).toBe('12345,00 €');
      expect(extractPrice(`EUR 2${sep}499,9`)).toBe('2499,90 €');
    });
  }

  it('con espacio normal no se inventa la cola como precio', () => {
    expect(extractPrice('Ahora 1 299,00 €')).not.toBe('299,00 €');
    expect(extractPrice('Talla 42 199 €')).not.toBe('199,00 €');
  });

  it('los formatos de antes no cambian', () => {
    expect(extractPrice('Ahora 1.299,00 €')).toBe('1299,00 €');
    expect(extractPrice('Solo 19,99€')).toBe('19,99 €');
    expect(extractPrice('Total: 25 €')).toBe('25,00 €');
    expect(extractPrice('Total: 25 € y envío 3 €')).toBe('25,00 €');
  });
});
