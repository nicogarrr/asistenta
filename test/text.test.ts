import { describe, expect, it } from 'vitest';
import { hostOf as browserHostOf } from '../src/browser/service.js';
import { foldAccents, normalizeHostname } from '../src/text.js';
import { hostOf as priceHostOf } from '../src/watch/price-extract.js';

describe('foldAccents', () => {
  it('quita tildes y diéresis y pasa a minúsculas', () => {
    expect(foldAccents('Árbol Ñandú PINGÜINO')).toBe('arbol nandu pinguino');
  });
  it('deja intactos los espacios y la puntuación', () => {
    expect(foldAccents('  ¿Qué tal?  ')).toBe('  ¿que tal?  ');
  });
});

describe('normalizeHostname', () => {
  it('minúsculas y sin punto final de FQDN', () => {
    expect(normalizeHostname('Amazon.ES.')).toBe('amazon.es');
    expect(normalizeHostname('pccomponentes.com')).toBe('pccomponentes.com');
  });
});

describe('hostOf con punto final', () => {
  it('vigilancia de precios: «www.amazon.es.» es el mismo host que «www.amazon.es»', () => {
    expect(priceHostOf('https://www.Amazon.es./dp/B000000000')).toBe('www.amazon.es');
    expect(priceHostOf('no es url')).toBe('');
  });
  it('navegador: sigue quitando www y el punto final', () => {
    expect(browserHostOf('https://WWW.PayPal.com./x')).toBe('paypal.com');
    expect(browserHostOf('::')).toBeNull();
  });
});
