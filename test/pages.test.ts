import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  describeChange,
  extractPrice,
  FAILURES_BEFORE_NOTICE,
  PageWatchStore,
  watchValue,
} from '../src/watch/pages.js';

const mk = () => {
  let t = 1_000;
  const store = new PageWatchStore(new DatabaseSync(':memory:'), () => t);
  return {
    store,
    tick: (ms: number) => {
      t += ms;
    },
  };
};

describe('extractPrice', () => {
  it('normalises Spanish and prefix formats', () => {
    expect(extractPrice('Ahora 49,90 € con envío')).toBe('49,90 €');
    expect(extractPrice('Precio: 1.299,5€')).toBe('1299,50 €');
    expect(extractPrice('Total € 20')).toBe('20,00 €');
    expect(extractPrice('sin precio aquí')).toBeNull();
  });
  it('falls back to a text hash that ignores whitespace and case', () => {
    expect(watchValue('Hola   Mundo')).toBe(watchValue(' hola mundo '));
    expect(watchValue('hola')).not.toBe(watchValue('adiós'));
  });
});

describe('PageWatchStore', () => {
  it('baselines, stays quiet, then reports a price drop once', async () => {
    const { store } = mk();
    const w = store.add('chat1', 'https://shop.example/p', 'Zapatillas');
    expect((await store.check(w, async () => 'Precio 80,00 €')).kind).toBe('baseline');
    const w2 = store.get(w.id) as typeof w;
    expect((await store.check(w2, async () => 'Precio 80,00 €')).kind).toBe('unchanged');
    const out = await store.check(store.get(w.id) as typeof w, async () => 'Precio 64,99 €');
    expect(out).toEqual({ kind: 'changed', from: '80,00 €', to: '64,99 €' });
    expect(describeChange(w, out)).toContain('80,00 € -> 64,99 €');
    // la referencia ya es la nueva: no vuelve a avisar
    expect((await store.check(store.get(w.id) as typeof w, async () => '64,99 €')).kind).toBe(
      'unchanged',
    );
  });

  it('a network error is not a change; it warns once at the threshold', async () => {
    const { store } = mk();
    const w = store.add('c', 'https://a.example/');
    await store.check(w, async () => '10 €');
    const notices: (string | null)[] = [];
    for (let i = 0; i < FAILURES_BEFORE_NOTICE + 2; i++) {
      const o = await store.check(store.get(w.id) as typeof w, async () => {
        throw new Error('timeout');
      });
      notices.push(describeChange(w, o));
    }
    expect(notices.filter(Boolean)).toHaveLength(1);
    expect(store.get(w.id)?.lastValue).toBe('10,00 €');
    // y al recuperarse, no es un cambio
    expect((await store.check(store.get(w.id) as typeof w, async () => '10 €')).kind).toBe(
      'unchanged',
    );
  });

  it('dedupes, caps, scopes and removes', () => {
    const { store } = mk();
    const a = store.add('c', 'https://a.example/');
    expect(store.add('c', 'https://a.example/').id).toBe(a.id);
    for (let i = 0; i < 9; i++) store.add('c', `https://x${i}.example/`);
    expect(() => store.add('c', 'https://more.example/')).toThrow(/10 páginas/);
    expect(store.list('otro')).toHaveLength(0);
    expect(store.remove('otro', a.id)).toBe(false);
    expect(store.remove('c', a.id)).toBe(true);
    expect(store.list('c')).toHaveLength(9);
  });

  it('due() returns only watches not checked within the interval', async () => {
    const { store, tick } = mk();
    const w = store.add('c', 'https://a.example/');
    await store.check(w, async () => '5 €');
    expect(store.due(60_000)).toHaveLength(0);
    tick(61_000);
    expect(store.due(60_000)).toHaveLength(1);
  });
});

describe('extractPrice con punto decimal y distintos formatos', () => {
  it.each([
    ['49.90 €', '49,90 €'],
    ['45.90 €', '45,90 €'],
    ['49.90€', '49,90 €'],
    ['€49.90', '49,90 €'],
    ['EUR 49.90', '49,90 €'],
    ['1.299,50 €', '1299,50 €'],
    ['1,299.50 €', '1299,50 €'],
    ['49,90 €', '49,90 €'],
    ['1.299 €', '1299,00 €'],
    ['49 €', '49,00 €'],
    ['12,5€', '12,50 €'],
    ['1,459 €', '1,459 €'],
    ['1.2345 €', null],
  ])('%s -> %s', (text, expected) => {
    expect(extractPrice(text)).toBe(expected);
  });

  it('un cambio 49.90 -> 45.90 se detecta (antes ambos eran 90,00 €)', () => {
    expect(extractPrice('Precio 49.90 €')).not.toBe(extractPrice('Precio 45.90 €'));
  });
});
