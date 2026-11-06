import { describe, expect, it } from 'vitest';
import { findTotalPrice } from '../src/tools/checkout.js';

// Resúmenes de pago de tiendas españolas (Mercadona, PcComponentes…): el subtotal
// «Total productos» y el total con «(IVA incluido)» hacían que el confirm denegara siempre.
describe('findTotalPrice con etiquetas de tiendas españolas', () => {
  it('«Total productos» es un subtotal: se salta y vale el total final', () => {
    const page = 'Total productos 45,30 €\nCoste de entrega 7,21 €\nTotal 52,51 €';
    expect(findTotalPrice(page)?.raw).toBe('52,51');
  });

  it('«Total (IVA incluido)» se lee', () => {
    expect(findTotalPrice('Total (IVA incluido): 50,20 €')?.raw).toBe('50,20');
    expect(findTotalPrice('Total (IVA incl.) 1.234,56 €')?.raw).toBe('1.234,56');
    expect(findTotalPrice('Total IVA incluido 9,99 €')?.raw).toBe('9,99');
  });

  it('las dos juntas: subtotal + total con IVA', () => {
    const page = 'Total productos: 45,30 €\nEnvío: 4,90 €\nTotal (IVA incluido): 50,20 €';
    expect(findTotalPrice(page)?.raw).toBe('50,20');
  });

  it('la semántica del guardia se mantiene', () => {
    // Solo hay subtotal: no hay total → se deniega.
    expect(findTotalPrice('Total productos 45,30 €')).toBeNull();
    expect(findTotalPrice('Total de los productos: 45,30 €')).toBeNull();
    // «Total IVA» sin «incluido» es el importe del impuesto: deniega como antes.
    expect(findTotalPrice('Total IVA: 8,00 €')).toBeNull();
    // Dos totales finales distintos: deniega.
    expect(findTotalPrice('Total (IVA incluido): 50,20 € Total: 60,00 €')).toBeNull();
    // Total con IVA ilegible: deniega, no busca otro precio.
    expect(findTotalPrice('Total (IVA incluido): consultar. Envío 9,99 €')).toBeNull();
  });
});
