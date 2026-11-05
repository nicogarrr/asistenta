import { describe, expect, it } from 'vitest';
import { parseVigilaArgs } from '../src/watch/pages.js';

const U = 'https://tienda.es/p/123';
const v = (rest: string) => {
  const r = parseVigilaArgs(`${U} ${rest}`);
  return r ? { target: r.targetCents, drop: r.dropPct, label: r.label } : null;
};

describe('/vigila: el objetivo y la bajada dichos normal', () => {
  it('«avísame si baja de 300 €» es un objetivo, no el nombre', () => {
    expect(v('avísame si baja de 300 €')).toEqual({ target: 30000, drop: null, label: '' });
    expect(v('cuando baje de 299,99')).toEqual({ target: 29999, drop: null, label: '' });
    expect(v('zapatillas por debajo de 50€')).toEqual({
      target: 5000,
      drop: null,
      label: 'zapatillas',
    });
    expect(v('menos de 1.000 € portátil')).toEqual({
      target: 100000,
      drop: null,
      label: 'portátil',
    });
    expect(v('objetivo 450')).toEqual({ target: 45000, drop: null, label: '' });
  });

  it('«si baja un 15%» es la bajada', () => {
    expect(v('si baja un 15%')).toEqual({ target: null, drop: 15, label: '' });
    expect(v('tele avísame cuando baje más de un 10 %')).toEqual({
      target: null,
      drop: 10,
      label: 'tele',
    });
  });

  it('lo de siempre no cambia', () => {
    expect(v('objetivo=500€ cafetera')).toEqual({ target: 50000, drop: null, label: 'cafetera' });
    expect(v('baja=10%')).toEqual({ target: null, drop: 10, label: '' });
    expect(v('Portátil Lenovo 15 pulgadas')).toEqual({
      target: null,
      drop: null,
      label: 'Portátil Lenovo 15 pulgadas',
    });
    expect(v('cafetera de 2 tazas')).toEqual({
      target: null,
      drop: null,
      label: 'cafetera de 2 tazas',
    });
  });
});
