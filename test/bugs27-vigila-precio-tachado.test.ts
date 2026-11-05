import { describe, expect, it } from 'vitest';
import { extractPrice, watchValue } from '../src/watch/pages.js';

describe('vigilancia de páginas: el precio tachado o el envío gratis no son el precio', () => {
  it('«Antes 1.299 € Ahora 999 €» se lee 999 €, no el tachado', () => {
    expect(extractPrice('Portátil X\nAntes 1.299,00 € Ahora 999,00 €')).toBe('999,00 €');
    expect(extractPrice('PVP: 349 € 279,90 € IVA incluido')).toBe('279,90 €');
    expect(extractPrice('Precio recomendado por el fabricante 1.199 €\nPrecio 949 €')).toBe(
      '949,00 €',
    );
  });

  it('el umbral de envío gratis de la cabecera y el ahorro no cuentan', () => {
    expect(extractPrice('Envío gratis en pedidos desde 49 €\nCafetera Z\n129,99 €')).toBe(
      '129,99 €',
    );
    expect(extractPrice('Ahorras 50 € · 199 €')).toBe('199,00 €');
    expect(watchValue('Gastos de envío gratis a partir de 30 €. Zapatillas 89,95 €')).toBe(
      '89,95 €',
    );
  });

  it('sin marcas, el primero como siempre; si todos están marcados, también el primero', () => {
    expect(extractPrice('Total: 25 € y envío 3 €')).toBe('25,00 €');
    expect(extractPrice('Solo 19,99€')).toBe('19,99 €');
    expect(extractPrice('Antes 30 €')).toBe('30,00 €');
    expect(extractPrice('Envío gratis. Precio: 999 €')).toBe('999,00 €');
    expect(extractPrice('Sin precio')).toBeNull();
  });
});
