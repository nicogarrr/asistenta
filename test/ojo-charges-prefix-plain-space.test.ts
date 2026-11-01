import { describe, expect, it } from 'vitest';
import { scanMoney } from '../src/ojo-charges.js';

// Con la divisa delante y miles separados por un espacio NORMAL, el lector se quedaba con
// el primer grupo: «€ 1 299,00» contaba como un cargo de 1 € y «EUR 12 345,50» de 12 €.
// Ahora es «formato no soportado» (bad): no se infiere ningún importe (solo más estricto).
describe('ojo-charges: divisa delante + espacio normal de miles', () => {
  it('«€ 1 299,00» no se lee como 1 €', () => {
    const r = scanMoney('Cargo en tu tarjeta de € 1 299,00 en Tienda');
    expect(r.bad).toBe(true);
    expect(r.cents).not.toContain(100);
  });

  it('«EUR 12 345,50» no se lee como 12 €', () => {
    const r = scanMoney('Importe: EUR 12 345,50');
    expect(r.bad).toBe(true);
    expect(r.cents).not.toContain(1200);
  });

  it('«€1 299,00» (sin espacio tras el símbolo) tampoco', () => {
    expect(scanMoney('Total €1 299,00').bad).toBe(true);
  });

  it('sigue leyendo los formatos soportados', () => {
    expect(scanMoney('Total € 1\u00a0299,00')).toEqual({ cents: [129900], bad: false });
    expect(scanMoney('Total EUR 12,50. Gracias')).toEqual({ cents: [1250], bad: false });
    expect(scanMoney('Cargo de 1.299,00 €')).toEqual({ cents: [129900], bad: false });
  });
});
