import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PageWatchStore } from '../src/watch/pages.js';

// bugs-34: el «🟢 vuelve a haber stock» (#2285) y el «🔴 se ha agotado» (#2299) comparaban
// solo con la lectura anterior. Si en medio llegaba una lectura sin disponibilidad (la
// ficha no traía «availability» esa vez: stock desconocido), el cambio se perdía:
// agotado → (sin dato) → en stock no avisaba nunca.

const URL = 'https://www.amazon.es/dp/B0ABC12345';
const IN = 'https://schema.org/InStock';
const OUT = 'https://schema.org/OutOfStock';

function ficha(price: string, availability: string | null): string {
  const avail = availability ? `,"availability":"${availability}"` : '';
  return `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Tele","offers":{"@type":"Offer","priceCurrency":"EUR","price":"${price}"${avail}}}</script>
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

describe('stock: se compara con la última lectura que decía el stock', () => {
  it('agotado → sin dato → en stock: avisa «vuelve a haber stock»', async () => {
    const { store, now } = mk();
    const w = store.add('c', URL, 'Tele');
    await store.check(w, noText, async () => ficha('499.00', OUT));
    now.t += 60_000;
    const mid = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', null),
    );
    expect(mid.kind).toBe('unchanged');
    now.t += 60_000;
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', IN),
    );
    expect(o).toEqual({ kind: 'restock', cents: 49900, prevCents: 49900 });
  });

  it('en stock → sin dato → agotado con «avísame si se agota»: avisa', async () => {
    const { store, now } = mk();
    const w = store.add('c', URL, 'Tele', '', { notifySoldOut: true });
    await store.check(w, noText, async () => ficha('499.00', IN));
    now.t += 60_000;
    await store.check(store.get(w.id) as typeof w, noText, async () => ficha('499.00', null));
    now.t += 60_000;
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', OUT),
    );
    expect(o).toEqual({ kind: 'soldout', cents: 49900 });
    // Sigue agotado (con o sin dato en medio): no se repite.
    now.t += 60_000;
    await store.check(store.get(w.id) as typeof w, noText, async () => ficha('499.00', null));
    now.t += 60_000;
    const again = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', OUT),
    );
    expect(again.kind).toBe('unchanged');
  });
});
