import { describe, expect, it } from 'vitest';
import { categoriasDesde } from '../src/precios/vigilante.js';

describe('precios: sin «más vendidos en alza»', () => {
  it('ninguna categoría pide movers-and-shakers (en Chrome llegan siempre vacíos)', () => {
    const urls = categoriasDesde('').categorias.flatMap((c) => c.urls);
    expect(urls.some((u) => u.includes('/gp/bestsellers/'))).toBe(true);
    expect(urls.filter((u) => u.includes('movers-and-shakers'))).toEqual([]);
  });
});
