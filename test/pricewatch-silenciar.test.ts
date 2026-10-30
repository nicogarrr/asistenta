import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { precioMuteArgs, pricewatchMuteButtons, pricewatchMuteReply } from '../src/cli.js';
import { PRICE_MUTE_MS, PriceStore, priceMuteKey, runOnce } from '../src/watch/pricewatch.js';
import { pricewatchNotifier } from '../src/watch/pricewatch-notify.js';

const DAY = 86_400_000;
const page = (price: string) => ({
  status: 200,
  html: `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X","offers":{"@type":"Offer","price":"${price}","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>`,
});
const URLS = {
  amazon: 'https://www.amazon.es/dp/B000000001',
  mediamarkt: 'https://www.mediamarkt.es/es/product/a.html',
  worten: 'https://www.worten.es/produtos/a',
};

function setup() {
  const now = { t: 10 * DAY };
  const sent: Array<{ text: string; muteKey?: string }> = [];
  const store = new PriceStore(new DatabaseSync(':memory:'), () => now.t);
  const pages: Record<string, { status: number; html: string }> = {
    [URLS.amazon]: page('20.00'),
    [URLS.mediamarkt]: page('100.00'),
    [URLS.worten]: page('110.00'),
  };
  store.record('TV', 'mediamarkt', 10000);
  store.record('TV', 'worten', 11000);
  const deps = () => ({
    store,
    products: [{ name: 'TV', urls: URLS }],
    gapMs: 1,
    minDropPct: 70,
    now: () => now.t,
    random: () => 0,
    fetchPage: async (u: string) => pages[u] ?? { status: 404, html: '' },
    robotsAllows: async () => true,
    sleep: async () => {},
    notify: async (text: string, opts?: { muteKey?: string }) =>
      void sent.push({ text, ...(opts?.muteKey ? { muteKey: opts.muteKey } : {}) }),
  });
  return { now, sent, store, deps };
}

describe('«🔕 Silenciar 1 día» en avisos del vigilante de precios', () => {
  it('el aviso de posible error de precio lleva la clave para silenciar el producto', async () => {
    const t = setup();
    const r = await runOnce(t.deps());
    expect(r.alerts).toBe(1);
    expect(t.sent[0]?.muteKey).toBe(priceMuteKey('TV'));
    expect(priceMuteKey('TV')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('silenciado: no avisa aunque pase el plazo de re-aviso por tienda; al acabar el día vuelve', async () => {
    const t = setup();
    t.now.t -= 2 * 3600_000;
    t.store.markAlerted('TV', 'amazon', 2000);
    t.now.t += 2 * 3600_000;
    expect(t.store.mute(priceMuteKey('TV'), PRICE_MUTE_MS)).toEqual({
      product: 'TV',
      until: 10 * DAY + PRICE_MUTE_MS,
    });
    t.now.t += 23 * 3600_000;
    expect(t.store.alertedRecently('TV', 'amazon')).toBe(false);
    expect((await runOnce(t.deps())).alerts).toBe(0);
    t.now.t += 2 * 3600_000;
    expect((await runOnce(t.deps())).alerts).toBe(1);
  });

  it('solo se silencia un producto que ya avisó; unmute lo quita antes', () => {
    const t = setup();
    expect(t.store.mute(priceMuteKey('TV'), PRICE_MUTE_MS)).toBeNull();
    t.store.markAlerted('TV', 'amazon', 2000);
    expect(t.store.mute('deadbeef', PRICE_MUTE_MS)).toBeNull();
    t.store.mute(priceMuteKey('TV'), PRICE_MUTE_MS);
    expect(t.store.mutedUntil('TV')).toBeGreaterThan(t.now.t);
    expect(t.store.unmute(priceMuteKey('TV'))).toBe('TV');
    expect(t.store.mutedUntil('TV')).toBe(0);
    expect(t.store.unmute(priceMuteKey('TV'))).toBeNull();
  });

  it('el botón equivale a /precio silenciar <clave>; la respuesta ofrece «🔔 Avisar otra vez»', () => {
    const [b] = pricewatchMuteButtons('a1b2c3d4');
    expect(b?.label).toBe('🔕 Silenciar 1 día');
    expect(commandFromCallback(b?.action ?? '')).toBe('/precio silenciar a1b2c3d4');
    expect(precioMuteArgs('silenciar a1b2c3d4')).toEqual({ action: 'silenciar', key: 'a1b2c3d4' });
    expect(precioMuteArgs('avisar a1b2c3d4')).toEqual({ action: 'avisar', key: 'a1b2c3d4' });
    expect(precioMuteArgs('12')).toBeNull();
    const r = pricewatchMuteReply('silenciar', 'a1b2c3d4', { product: 'TV', until: 10 * DAY });
    expect(r.text).toContain('🔕 Silenciado 1 día: TV');
    expect(commandFromCallback(r.buttons[0]?.action ?? '')).toBe('/precio avisar a1b2c3d4');
    expect(pricewatchMuteReply('avisar', 'a1b2c3d4', { product: 'TV', until: 0 })).toEqual({
      text: '🔔 Vuelvo a avisarte de TV.',
      buttons: [],
    });
    expect(pricewatchMuteReply('silenciar', 'a1b2c3d4', null).buttons).toEqual([]);
  });

  it('Telegram: los botones solo viajan si avisa el bot principal (el otro bot no recibe la pulsación)', async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const send = (async (url: string, init: { body: string }) => {
      bodies.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    const log = { info: () => {}, warn: () => {} };
    const buttons = [{ label: '🔕 Silenciar 1 día', action: 'cmd:precio silenciar a1b2c3d4' }];
    const main = pricewatchNotifier({
      token: '',
      mainBotToken: 'MAIN',
      chatId: '1',
      out: async () => {},
      log,
      send,
    });
    await main('aviso', { buttons });
    expect(bodies[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🔕 Silenciar 1 día', callback_data: 'cmd:precio silenciar a1b2c3d4' }],
      ],
    });
    const other = pricewatchNotifier({
      token: 'OTRO',
      mainBotToken: 'MAIN',
      chatId: '1',
      out: async () => {},
      log,
      send,
    });
    await other('aviso', { buttons });
    expect(bodies[1]?.body.reply_markup).toBeUndefined();
    await other('sin botones');
    expect(bodies[2]?.body.reply_markup).toBeUndefined();
  });
});
