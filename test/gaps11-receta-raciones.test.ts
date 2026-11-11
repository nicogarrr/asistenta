import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompraStore, recetaACompra } from '../src/compra.js';
import { recetaItems, scaleIngredient, servingsOf, splitRaciones } from '../src/compra-receta.js';

let dir: string;
let store: CompraStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps11-raciones-'));
  store = new CompraStore(join(dir, 'lista-compra.json'), 'telegram:1');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PAGE = `<script type="application/ld+json">{"@type":"Recipe","name":"Lentejas","recipeYield":"4 raciones",
"recipeIngredient":["300 g de lentejas","1 chorizo","2 zanahorias","½ cebolla","1,5 l de agua","Aceite de oliva"]}</script>`;

describe('/compra receta … para N: escala las cantidades', () => {
  it('lee las raciones de la receta', () => {
    expect(servingsOf('4 raciones')).toBe(4);
    expect(servingsOf(['6', '6 servings'])).toBe(6);
    expect(servingsOf(2)).toBe(2);
    expect(servingsOf('Para 8 personas')).toBe(8);
    expect(servingsOf('Raciones: 3')).toBe(3);
    expect(servingsOf('una bandeja')).toBeUndefined();
    expect(recetaItems({ text: 'Ingredientes (4 personas):\n- 200 g de arroz' }).servings).toBe(4);
  });

  it('escala la cantidad inicial con redondeo de compra', () => {
    expect(scaleIngredient('300 g de lentejas', 1.5)).toBe('450 g de lentejas');
    // bugs-35: con el plural (antes «2 chorizo»).
    expect(scaleIngredient('1 chorizo', 1.5)).toBe('2 chorizos');
    expect(scaleIngredient('½ cebolla', 1.5)).toBe('1 cebolla');
    expect(scaleIngredient('1,5 l de leche', 1.5)).toBe('2,3 l de leche');
    expect(scaleIngredient('2 cucharadas de miel', 1.5)).toBe('3 cucharadas de miel');
    expect(scaleIngredient('1/2 taza de azúcar', 2)).toBe('1 taza de azúcar');
    expect(scaleIngredient('Aceite de oliva', 2)).toBe('Aceite de oliva');
    expect(scaleIngredient('300 g de lentejas', 1)).toBe('300 g de lentejas');
  });

  it('«para 6» al final se separa del enlace o del texto', () => {
    expect(splitRaciones('https://x.es/lentejas para 6')).toEqual({
      rest: 'https://x.es/lentejas',
      servings: 6,
    });
    expect(splitRaciones('https://x.es/lentejas 8 personas').servings).toBe(8);
    expect(splitRaciones('https://x.es/lentejas')).toEqual({ rest: 'https://x.es/lentejas' });
  });

  it('de 4 a 6 raciones: lo dice y apunta las cantidades escaladas (sin el agua)', async () => {
    const view = await recetaACompra(store, 'https://x.es/lentejas para 6', async () => PAGE);
    expect(view.text).toContain('«Lentejas» (de 4 a 6 raciones): apunto 5 ingredientes');
    expect(store.list().map((i) => i.text)).toEqual([
      '450 g de lentejas',
      '2 chorizos',
      '3 zanahorias',
      '1 cebolla',
      'Aceite de oliva',
    ]);
  });

  it('si la receta no dice para cuántos, cantidades tal cual y lo avisa', async () => {
    const view = await recetaACompra(store, 'Ingredientes:\n- 200 g de arroz\n- 1 pimiento para 6');
    expect(view.text).toContain('no dice para cuántos es');
    expect(store.list().map((i) => i.text)).toEqual(['200 g de arroz', '1 pimiento']);
  });

  it('ya era para esas raciones: nada que escalar', async () => {
    const view = await recetaACompra(store, 'https://x.es/lentejas para 4', async () => PAGE);
    expect(view.text).toContain('Ya era para 4.');
    expect(store.list().map((i) => i.text)[0]).toBe('300 g de lentejas');
  });
});
