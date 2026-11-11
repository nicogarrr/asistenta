import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { pageNotice } from '../src/cli.js';
import { describeChange, PageWatchStore } from '../src/watch/pages.js';

const URL = 'https://www.amazon.es/dp/B0ABC12345';
const IN = 'https://schema.org/InStock';
const OUT = 'https://schema.org/OutOfStock';

/** Ficha mínima con JSON-LD + meta coherentes (consenso de dos fuentes). */
function ficha(price: string, availability: string): string {
  return `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Tele","offers":{"@type":"Offer","priceCurrency":"EUR","price":"${price}","availability":"${availability}"}}</script>
<meta property="product:price:amount" content="${price}">
</head><body></body></html>`;
}
const noText = async (): Promise<string> => {
  throw new Error('no');
};
function mk() {
  const now = { t: Date.UTC(2026, 10, 11, 10, 0) };
  const store = new PageWatchStore(new DatabaseSync(':memory:'), () => now.t);
  return { store, now };
}

describe('aviso «vuelve a haber stock» (Grok Bot: Notify me)', () => {
  it('agotado → en stock al mismo precio: avisa (antes se callaba porque el precio no cambiaba)', async () => {
    const { store, now } = mk();
    const w = store.add('c', URL, 'Tele');
    expect((await store.check(w, noText, async () => ficha('499.00', OUT))).kind).toBe('baseline');
    expect(
      (await store.check(store.get(w.id) as typeof w, noText, async () => ficha('499.00', OUT)))
        .kind,
    ).toBe('unchanged');
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', IN),
    );
    expect(o).toEqual({ kind: 'restock', cents: 49900, prevCents: 49900 });
    const n = pageNotice(store.get(w.id) as typeof w, o, now.t);
    expect(n?.text).toContain('🟢 Vuelve a haber stock en Tele, al mismo precio, 499,00 €');
    expect(n?.text).toContain(URL);
    expect(n?.buttons.map((b) => b.label)).toEqual(['🔕 Silenciar 1 día']);
    // Sigue en stock: no se repite.
    expect(
      (await store.check(store.get(w.id) as typeof w, noText, async () => ficha('499.00', IN)))
        .kind,
    ).toBe('unchanged');
  });

  it('vuelve con otro precio: lo dice con el de cuando se agotó', async () => {
    const { store } = mk();
    const w = store.add('c', URL, 'Tele');
    await store.check(w, noText, async () => ficha('499.00', OUT));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('529.00', IN),
    );
    expect(o.kind).toBe('restock');
    expect(describeChange(store.get(w.id) as typeof w, o)).toContain(
      'a 529,00 € (cuando se agotó estaba a 499,00 €)',
    );
  });

  it('el objetivo de precio manda si se cumple a la vez (el aviso ya dice «en stock»)', async () => {
    const { store } = mk();
    const w = store.add('c', URL, 'Tele', '', { targetCents: 45_000 });
    await store.check(w, noText, async () => ficha('499.00', OUT));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('449.00', IN),
    );
    expect(o.kind).toBe('target');
    expect(describeChange(store.get(w.id) as typeof w, o)).toContain('en stock');
  });

  it('en stock → agotado no es un aviso de «vuelve»', async () => {
    const { store } = mk();
    const w = store.add('c', URL, 'Tele');
    await store.check(w, noText, async () => ficha('499.00', IN));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', OUT),
    );
    expect(o.kind).toBe('unchanged');
  });

  it('silenciada: el aviso de stock también calla', async () => {
    const { store, now } = mk();
    const w = store.add('c', URL, 'Tele');
    await store.check(w, noText, async () => ficha('499.00', OUT));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', IN),
    );
    const muted = store.mute('c', w.id, 86_400_000);
    if (!muted) throw new Error('sin silenciar');
    expect(pageNotice(muted, o, now.t + 1000)).toBeNull();
  });
});
