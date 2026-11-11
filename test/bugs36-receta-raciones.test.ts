import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompraStore, recetaACompra } from '../src/compra.js';
import { cambiarAporte } from '../src/compra-sumar.js';

// bugs-36 (lead de bugs-35): «/compra receta … para 6» de una receta ya apuntada «para 4»
// contestaba «Ya estaba» y la lista seguía con las cantidades para 4: la clave de la receta
// no lleva las raciones (#2345) y la misma receta no volvía a contar.

const PAGE = `<script type="application/ld+json">{"@type":"Recipe","name":"Tortilla","recipeYield":"4 raciones",
"recipeIngredient":["4 huevos","500 g de patatas","1 cebolla"]}</script>`;
const URL_ = 'https://x.es/tortilla';
const receta = (s: CompraStore, raciones = '') =>
  recetaACompra(s, `${URL_}${raciones}`, async () => PAGE);

describe('la misma receta con otras raciones reescala su parte', () => {
  let dir = '';
  let store: CompraStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-raciones-'));
    store = new CompraStore(join(dir, 'compra.json'), 'telegram:main:1');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const textos = () => store.list().map((i) => i.text);

  it('de 4 a 6: las cantidades pasan a las de 6, sin «ya estaba»', async () => {
    await receta(store);
    expect(textos()).toEqual(['4 huevos', '500 g de patatas', '1 cebolla']);
    const v = await receta(store, ' para 6');
    expect(textos()).toEqual(['6 huevos', '750 g de patatas', '2 cebollas']);
    expect(v.text).toContain('Ajustado a las raciones nuevas');
    expect(v.text).toContain('4 huevos → 6 huevos');
    expect(v.text).not.toContain('Ya estaba: 4 huevos');
  });

  it('solo cambia la parte de esta receta: lo de otra se queda', async () => {
    store.add(['2 huevos']);
    await receta(store);
    expect(textos()).toContain('6 huevos');
    await receta(store, ' para 2');
    expect(textos()).toContain('4 huevos');
    expect(textos()).toContain('250 g de patatas');
  });

  it('con las mismas raciones sigue sin sumar ni avisar de cambios', async () => {
    await receta(store, ' para 6');
    const antes = textos();
    const v = await receta(store, ' para 6');
    expect(textos()).toEqual(antes);
    expect(v.text).not.toContain('Ajustado');
  });

  it('cambiarAporte', () => {
    expect(cambiarAporte('5 huevos', '2 huevos', '3 huevos')).toBe('6 huevos');
    expect(cambiarAporte('1 kg de harina', '200 g de harina', '300 g de harina')).toBe(
      '1,1 kg de harina',
    );
    expect(cambiarAporte('2 huevos', '2 huevos', '3 huevos')).toBe('3 huevos');
    expect(cambiarAporte('2 tazas de harina', '200 g de harina', '300 g de harina')).toBeNull();
  });
});
