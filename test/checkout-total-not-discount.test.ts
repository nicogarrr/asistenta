import { describe, expect, it } from 'vitest';
import { findTotalPrice } from '../src/tools/checkout.js';

describe('checkout: un "total" de descuento, IVA o envío no es el total de la compra', () => {
  for (const text of [
    'Portátil X1. Descuento total: 5,00 €. Importe final 450,00 €',
    'Ahorro total: 120,00 € en tu pedido de 980,00 €',
    'IVA total: 9,45 €',
    'Gastos de envío total: 4,99 €',
    'Discount total: €5',
    'Shipping total: 4,99 €',
  ]) {
    it(text, () => {
      expect(findTotalPrice(text)).toBeNull();
    });
  }

  it('el total de verdad se sigue leyendo', () => {
    expect(findTotalPrice('Subtotal 40,00 € Total: 45,20 €')?.raw).toBe('45,20');
    expect(findTotalPrice('Total a pagar: 1.234,56 €')?.raw).toBe('1.234,56');
  });
});
