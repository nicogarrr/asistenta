import { describe, expect, it } from 'vitest';
import { pickMatch, titleOverlap } from '../src/watch/compare.js';

const card = (title: string, cents = 100) => ({ title, url: `https://x.es/${cents}`, cents });

describe('titleOverlap: el título parecido no puede ser otro producto', () => {
  it('sigue aceptando el mismo producto con palabras de más en la tienda', () => {
    expect(
      titleOverlap('Apple iPhone 15 128GB Negro', 'Smartphone Apple iPhone 15 128 GB Negro, eSIM'),
    ).toBeGreaterThanOrEqual(0.7);
    expect(
      titleOverlap('Samsung TU65M73HAUXXC 65 pulgadas', 'TV Samsung TU65M73HAUXXC 65 pulgadas 4K'),
    ).toBeGreaterThanOrEqual(0.7);
    expect(
      titleOverlap('Cafetera Delonghi Magnifica', 'Cafetera superautomática DeLonghi Magnífica'),
    ).toBe(1);
  });

  it('otra generación del modelo no es el mismo producto (las cifras cortas cuentan)', () => {
    expect(titleOverlap('Apple iPhone 15 128GB Negro', 'Apple iPhone 14 128GB Negro')).toBeLessThan(
      0.7,
    );
  });

  it('otra capacidad no es el mismo producto', () => {
    expect(titleOverlap('Apple iPhone 15 128GB Negro', 'Apple iPhone 15 256GB Negro')).toBeLessThan(
      0.7,
    );
  });

  it('un accesorio que contiene el título del producto no es el producto', () => {
    expect(
      titleOverlap(
        'Apple iPhone 15 128GB Negro',
        'Funda de silicona para Apple iPhone 15 128GB Negro',
      ),
    ).toBeLessThan(0.7);
    expect(
      titleOverlap('Samsung TU65M73HAUXXC 65', 'Soporte de pared TV 65 Samsung TU65M73HAUXXC'),
    ).toBe(0);
  });

  it('si la semilla ES el accesorio, se compara como cualquier otro producto', () => {
    expect(
      titleOverlap(
        'Funda silicona iPhone 15 negra',
        'Funda de silicona Apple iPhone 15 negra MagSafe',
      ),
    ).toBeGreaterThanOrEqual(0.7);
  });

  it('semilla vacía o solo de palabras vacías: nunca empareja; una cifra corta sí cuenta', () => {
    expect(titleOverlap('TV 4K', 'TV 4K')).toBe(1);
    expect(titleOverlap('', 'Lo que sea')).toBe(0);
    expect(titleOverlap('con para sin', 'con para sin')).toBe(0);
  });
});

describe('pickMatch: el más barato del buscador no puede ser una funda', () => {
  it('por título: descarta el accesorio más barato y elige el producto', () => {
    const cards = [
      card('Funda para Apple iPhone 15 128GB Negro', 1299),
      card('Apple iPhone 14 128GB Negro', 69900),
      card('Apple iPhone 15 128 GB Negro', 82900),
    ];
    const picked = pickMatch(cards, {
      title: 'Apple iPhone 15 128GB Negro',
      ean: null,
      model: null,
    });
    expect(picked?.card.cents).toBe(82900);
    expect(picked?.match).toBe('titulo');
  });

  it('por título: si solo hay accesorios u otro modelo, no lo encuentra', () => {
    const cards = [
      card('Funda para Apple iPhone 15 128GB Negro', 1299),
      card('Apple iPhone 14 128GB Negro', 69900),
    ];
    expect(
      pickMatch(cards, { title: 'Apple iPhone 15 128GB Negro', ean: null, model: null }),
    ).toBeNull();
  });

  it('por modelo: un mando o un soporte con el mismo código no es la tele', () => {
    const cards = [
      card('Mando a distancia compatible Samsung TU65M73HAUXXC', 999),
      card('Samsung TU65M73HAUXXC Smart TV 65', 59900),
    ];
    const picked = pickMatch(cards, {
      title: 'Samsung TU65M73HAUXXC 65 pulgadas',
      ean: null,
      model: 'm:tu65m73hauxxc',
    });
    expect(picked?.card.cents).toBe(59900);
    expect(picked?.match).toBe('modelo');
  });
});
