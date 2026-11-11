import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompraStore, recetaACompra } from '../src/compra.js';
import { ingredientKey, parseCantidad, sumarLinea } from '../src/compra-sumar.js';

describe('sumar cantidades del mismo ingrediente', () => {
  it('suma en la unidad de la que ya estaba y convierte g/kg y ml/l', () => {
    expect(sumarLinea('200 g de harina', '100 g de harina')).toBe('300 g de harina');
    expect(sumarLinea('1 kg de harina', '200 g de harina')).toBe('1,2 kg de harina');
    expect(sumarLinea('500 ml de leche', '1 l de leche')).toBe('1500 ml de leche');
    expect(sumarLinea('2 huevos', '3 huevos')).toBe('5 huevos');
    expect(sumarLinea('1 huevo', '2 huevos')).toBe('3 huevos');
    expect(sumarLinea('2 cucharadas de azúcar', '1 cucharada de azúcar')).toBe(
      '3 cucharadas de azúcar',
    );
    expect(sumarLinea('½ kg de patatas', '1 kg de patatas')).toBe('1,5 kg de patatas');
  });

  it('no suma lo que no casa', () => {
    expect(sumarLinea('2 tazas de harina', '200 g de harina')).toBeNull();
    expect(sumarLinea('200 g de harina', '200 g de azúcar')).toBeNull();
    expect(sumarLinea('harina', '200 g de harina')).toBeNull();
    expect(sumarLinea('200 g de harina de trigo', '100 g de harina')).toBeNull();
  });

  it('reconoce el mismo ingrediente en singular y plural, con y sin acentos', () => {
    expect(ingredientKey('2 limones')).toBe(ingredientKey('1 limón'));
    expect(ingredientKey('3 tomates')).toBe(ingredientKey('1 tomate'));
    expect(ingredientKey('2 nueces')).toBe(ingredientKey('1 nuez'));
    expect(parseCantidad('Aceite de oliva')).toBeNull();
    expect(parseCantidad('1,5 kg de patatas')?.q).toBe(1.5);
  });
});

describe('/compra receta suma a lo que ya hay en la lista', () => {
  let dir = '';
  let store: CompraStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps12-compra-'));
    store = new CompraStore(join(dir, 'lista.json'), 'telegram:42');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('200 g de harina en la lista + receta con 100 g → una línea de 300 g, y lo dice', async () => {
    store.add(['200 g de harina', 'leche']);
    const view = await recetaACompra(
      store,
      'Ingredientes:\n- 100 g de harina\n- 2 huevos\n- 200 ml de leche\nPreparación: mezclar',
    );
    const texts = store.list().map((i) => i.text);
    expect(texts).toContain('300 g de harina');
    expect(texts).not.toContain('100 g de harina');
    expect(texts).toContain('2 huevos');
    // «leche» sin cantidad ya estaba: no se duplica.
    expect(texts.filter((t) => /leche/.test(t))).toEqual(['leche']);
    expect(view.text).toContain('Sumado a lo que ya tenías: 200 g de harina → 300 g de harina');
    expect(view.text).toContain('Ya estaba: leche');
  });

  it('dos recetas con 2 y 3 huevos → una línea de 5 (antes: dos líneas)', async () => {
    await recetaACompra(store, 'Ingredientes:\n- 2 huevos\n- 100 g de azúcar');
    await recetaACompra(store, 'Ingredientes:\n- 3 huevos\n- 1 limón');
    const texts = store.list().map((i) => i.text);
    expect(texts).toContain('5 huevos');
    expect(texts.filter((t) => /huevo/.test(t))).toHaveLength(1);
  });

  it('la misma receta dos veces (o el modelo que la repite) no duplica cantidades', async () => {
    const receta = 'Ingredientes:\n- 200 g de harina\n- 2 huevos';
    await recetaACompra(store, receta);
    const view = await recetaACompra(store, receta);
    expect(store.list().map((i) => i.text)).toEqual(['200 g de harina', '2 huevos']);
    expect(view.text).toContain('Ya estaba: 200 g de harina, 2 huevos');
  });

  it('lo ya tachado no se suma: vuelve a por comprar con lo que pide la receta', async () => {
    store.add(['3 huevos']);
    const id = store.list()[0]?.id ?? 0;
    store.toggle(id);
    await recetaACompra(store, 'Ingredientes:\n- 2 huevos');
    const pending = store
      .list()
      .filter((i) => !i.done)
      .map((i) => i.text);
    expect(pending).toEqual(['2 huevos']);
  });

  it('unidades que no se suman: queda en su línea, como antes', async () => {
    store.add(['2 tazas de harina']);
    await recetaACompra(store, 'Ingredientes:\n- 200 g de harina');
    expect(store.list().map((i) => i.text)).toEqual(['2 tazas de harina', '200 g de harina']);
  });

  it('/compra a mano sigue igual (no suma): «2 huevos» repetido es «ya estaba»', () => {
    store.add(['2 huevos']);
    expect(store.add(['2 huevos']).already).toEqual(['2 huevos']);
    expect(store.list()).toHaveLength(1);
  });
});
