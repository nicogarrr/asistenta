import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { pageNotice } from '../src/cli.js';
import { createPriceWatchTool } from '../src/tools/price-watch.js';
import { PageWatchStore, parseVigilaArgs } from '../src/watch/pages.js';

const URL = 'https://www.amazon.es/dp/B0ABC12345';
const IN = 'https://schema.org/InStock';
const OUT = 'https://schema.org/OutOfStock';

function ficha(price: string, availability: string): string {
  return `<html><head>
<script type="application/ld+json">{"@type":"Product","name":"Tele","offers":{"@type":"Offer","priceCurrency":"EUR","price":"${price}","availability":"${availability}"}}</script>
<meta property="product:price:amount" content="${price}">
</head><body></body></html>`;
}
const noText = async (): Promise<string> => {
  throw new Error('no');
};
function mk(db = new DatabaseSync(':memory:')) {
  const now = { t: Date.UTC(2026, 10, 11, 10, 0) };
  const store = new PageWatchStore(db, () => now.t);
  return { store, now, db };
}

describe('aviso «se ha agotado» (opt-in, el contrario de #2285)', () => {
  it('apagado por defecto: en stock → agotado al mismo precio no avisa', async () => {
    const { store } = mk();
    const w = store.add('c', URL, 'Tele');
    expect(w.notifySoldOut).toBe(false);
    await store.check(w, noText, async () => ficha('499.00', IN));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', OUT),
    );
    expect(o.kind).toBe('unchanged');
  });

  it('encendido: avisa una vez con el último precio con stock y el botón de silenciar', async () => {
    const { store, now } = mk();
    const w = store.add('c', URL, 'Tele', '', { notifySoldOut: true });
    await store.check(w, noText, async () => ficha('499.00', IN));
    const o = await store.check(store.get(w.id) as typeof w, noText, async () =>
      ficha('499.00', OUT),
    );
    expect(o).toEqual({ kind: 'soldout', cents: 49900 });
    const n = pageNotice(store.get(w.id) as typeof w, o, now.t);
    expect(n?.text).toContain('🔴 Se ha agotado Tele (con stock estaba a 499,00 €)');
    expect(n?.text).toContain(URL);
    expect(n?.buttons.map((b) => b.label)).toEqual(['🔕 Silenciar 1 día']);
    // Sigue agotado: no se repite; vuelve: «vuelve a haber stock».
    expect(
      (await store.check(store.get(w.id) as typeof w, noText, async () => ficha('499.00', OUT)))
        .kind,
    ).toBe('unchanged');
    expect(
      (await store.check(store.get(w.id) as typeof w, noText, async () => ficha('499.00', IN)))
        .kind,
    ).toBe('restock');
  });

  it('la primera lectura ya agotada es solo la referencia', async () => {
    const { store } = mk();
    const w = store.add('c', URL, 'Tele', '', { notifySoldOut: true });
    expect((await store.check(w, noText, async () => ficha('499.00', OUT))).kind).toBe('baseline');
  });

  it('volver a pedirlo sobre la misma ficha lo enciende sin duplicar ni tocar el objetivo', () => {
    const { store } = mk();
    const w = store.add('c', URL, 'Tele', '', { targetCents: 40_000 });
    const again = store.add('c', URL, '', '', { notifySoldOut: true });
    expect(again.id).toBe(w.id);
    expect(again.notifySoldOut).toBe(true);
    expect(again.targetCents).toBe(40_000);
    expect(store.list('c')).toHaveLength(1);
    expect(store.setNotifySoldOut('c', w.id, false)?.notifySoldOut).toBe(false);
    expect(store.setNotifySoldOut('otro', w.id, true)).toBeNull();
  });

  it('migra una base vieja sin la columna', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE page_watches (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      last_value TEXT NOT NULL DEFAULT '', last_checked_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    db.exec(
      "INSERT INTO page_watches (id, scope, url, created_at) VALUES ('ab12cd34', 'c', 'https://x.es', 1)",
    );
    const { store } = mk(db);
    expect(store.get('ab12cd34')?.notifySoldOut).toBe(false);
  });

  it('/vigila entiende «avísame si se agota» y agotado=sí|no sin confundirlo con palabra=agotado', () => {
    expect(parseVigilaArgs(`${URL} Tele avísame si se agota`)).toMatchObject({
      notifySoldOut: true,
      label: 'Tele',
    });
    expect(parseVigilaArgs(`${URL} agotado=sí`)?.notifySoldOut).toBe(true);
    expect(parseVigilaArgs(`${URL} agotado=no`)?.notifySoldOut).toBe(false);
    const kw = parseVigilaArgs(`${URL} palabra=agotado`);
    expect(kw).toMatchObject({ keyword: 'agotado', notifySoldOut: null });
    expect(parseVigilaArgs(`${URL} objetivo=400€ cuando se agote`)).toMatchObject({
      targetCents: 40_000,
      notifySoldOut: true,
    });
  });

  it('la herramienta del modelo lo acepta con notify_sold_out y la ficha lo dice', async () => {
    const { store } = mk();
    const tool = createPriceWatchTool({
      watches: store,
      scopeOf: () => 'c',
      isFetchable: async () => true,
    } as never);
    const r = await tool.execute(
      't1',
      { action: 'add', url: URL, notify_sold_out: true } as never,
      undefined,
      undefined,
    );
    expect(JSON.stringify(r.content)).toContain('aviso si se agota');
    const w = store.list('c')[0];
    expect(w?.notifySoldOut).toBe(true);
  });
});
