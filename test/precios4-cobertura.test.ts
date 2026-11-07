import { describe, expect, it } from 'vitest';
import { categoriasDesde } from '../src/precios/vigilante.js';

// Caso real 7-nov-2026: «RexingUSA Cámara de salpicadero V1-4K» (B0BSJZPSJP) bajó a 19,73 €
// (~170 € esa semana) y no salió: su categoría (Coche y moto › Electrónica para vehículos) no
// estaba en el barrido por defecto.
describe('cobertura del barrido por defecto', () => {
  const ids = categoriasDesde('').categorias.map((c) => c.id);

  it('barre Coche y moto (más vendidos y novedades)', () => {
    expect(ids).toContain('coche');
    const coche = categoriasDesde('coche').categorias[0];
    expect(coche?.urls).toEqual([
      'https://www.amazon.es/gp/bestsellers/automotive/',
      'https://www.amazon.es/s?i=automotive&s=date-desc-rank',
    ]);
  });

  it('y más categorías generales, no productos sueltos', () => {
    for (const id of ['jardin', 'iluminacion', 'salud', 'mascotas', 'instrumentos'])
      expect(ids).toContain(id);
    expect(categoriasDesde('Coche, jardín').desconocidas).toEqual([]);
  });
});
