import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompraStore, recetaACompra } from '../src/compra.js';

// bugs-35 (revisión de #2316): la lista no sabía de qué receta venía cada cosa.
// - Dos recetas DISTINTAS que piden «2 huevos» dejaban «2 huevos» («ya estaba»): faltaban 2.
// - La MISMA receta mandada otra vez, si su línea se había sumado a otra («100 g» de antes
//   + «200 g» = «300 g»), se volvía a sumar: «500 g». La guarda de «mismo texto exacto» solo
//   cubría el caso en que nada se hubiera sumado.

let dir = '';
let store: CompraStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs35-compra-'));
  store = new CompraStore(join(dir, 'lista.json'), 'telegram:main:42');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tortilla = 'Ingredientes:\n- 2 huevos\n- 200 g de harina';
const bizcocho = 'Ingredientes:\n- 2 huevos\n- 100 ml de leche';
const texts = () =>
  store
    .list()
    .filter((i) => !i.done)
    .map((i) => i.text);

describe('/compra receta: cada receta cuenta una vez', () => {
  it('dos recetas distintas con la misma línea suman', async () => {
    await recetaACompra(store, tortilla);
    await recetaACompra(store, bizcocho);
    expect(texts()).toContain('4 huevos');
    expect(texts()).not.toContain('2 huevos');
  });

  it('la misma receta otra vez no suma de nuevo, aunque su línea se sumara a otra', async () => {
    store.add(['100 g de harina']);
    await recetaACompra(store, tortilla);
    expect(texts()).toContain('300 g de harina');
    await recetaACompra(store, tortilla);
    expect(texts()).toContain('300 g de harina');
    expect(texts()).toContain('2 huevos');
  });

  it('lo apuntado a mano igual que la receta sigue siendo «ya estaba» (no se sabe si era para ella)', async () => {
    store.add(['2 huevos']);
    await recetaACompra(store, tortilla);
    expect(texts()).toContain('2 huevos');
    expect(texts()).not.toContain('4 huevos');
  });
});
