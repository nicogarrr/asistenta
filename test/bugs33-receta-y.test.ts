import { describe, expect, it } from 'vitest';
import { recetaItems } from '../src/compra-receta.js';

// bugs-33 (11 nov 2026): «/compra receta Ingredientes: harina, huevos y leche» apuntaba
// «huevos y leche» como UNA cosa de la lista de la compra.

describe('/compra receta: la lista en una línea', () => {
  it('«harina, huevos y leche» son tres cosas', () => {
    const r = recetaItems({ text: 'Ingredientes: harina, huevos y leche\nPasos: mezclar' });
    expect(r.items).toEqual(['harina', 'huevos', 'leche']);
  });

  it('«e» también separa, y «sal y pimienta» sigue fuera por ser de casa', () => {
    const r = recetaItems({ text: 'Ingredientes: 2 huevos, harina e higos, sal y pimienta' });
    expect(r.items).toEqual(['2 huevos', 'harina', 'higos']);
  });

  it('una línea suelta de la lista con «y» no se parte (el título manda en una línea)', () => {
    const r = recetaItems({ text: 'Ingredientes\n- 1 bote de garbanzos y su caldo\n- 1 cebolla' });
    expect(r.items).toEqual(['1 bote de garbanzos y su caldo', '1 cebolla']);
  });
});
