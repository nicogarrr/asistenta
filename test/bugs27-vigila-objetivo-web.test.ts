import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { describeChange, PageWatchStore } from '../src/watch/pages.js';

const URL_WEB = 'https://www.decathlon.es/es/p/zapatillas-x/123';

function mk() {
  const store = new PageWatchStore(new DatabaseSync(':memory:'), () => 1_800_000_000_000);
  return { store };
}

const page = (price: string) => async () => `Zapatillas X\nPrecio ${price} €\nEnvío en 48 h`;

describe('/vigila en una web que no es de las 7 tiendas: objetivo y bajada', () => {
  it('objetivo: avisa al cruzar el umbral a la baja, no de cada cambio', async () => {
    const { store } = mk();
    const w = store.add('c', URL_WEB, 'Zapas', '', { targetCents: 5000 });
    expect((await store.check(w, page('64,99'))).kind).toBe('baseline');
    const o = await store.check(store.get(w.id) as typeof w, page('49,99'));
    expect(o).toMatchObject({ kind: 'target', cents: 4999, targetCents: 5000 });
    expect(describeChange(store.get(w.id) as typeof w, o)).toContain('Objetivo conseguido');
    // Sigue por debajo: no vuelve a avisar de objetivo.
    expect((await store.check(store.get(w.id) as typeof w, page('45,00'))).kind).toBe('changed');
  });

  it('objetivo ya cumplido en la primera lectura también avisa', async () => {
    const { store } = mk();
    const w = store.add('c', URL_WEB, 'Zapas', '', { targetCents: 5000 });
    expect((await store.check(w, page('39,90'))).kind).toBe('target');
  });

  it('bajada %: respecto a la última lectura', async () => {
    const { store } = mk();
    const w = store.add('c', URL_WEB, 'Zapas', '', { dropPct: 20 });
    await store.check(w, page('100,00'));
    expect((await store.check(store.get(w.id) as typeof w, page('90,00'))).kind).toBe('changed');
    const o = await store.check(store.get(w.id) as typeof w, page('70,00'));
    expect(o).toMatchObject({ kind: 'drop', cents: 7000, referenceCents: 9000, dropPct: 22.2 });
  });

  it('sin objetivo ni bajada, como siempre', async () => {
    const { store } = mk();
    const w = store.add('c', URL_WEB, 'Zapas', '');
    await store.check(w, page('64,99'));
    expect(await store.check(store.get(w.id) as typeof w, page('49,99'))).toMatchObject({
      kind: 'changed',
      from: '64,99 €',
      to: '49,99 €',
    });
  });
});
