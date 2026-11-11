import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, bandejaSlowSub } from '../src/bandeja/comando.js';
import { cardButtons, compraButton } from '../src/bandeja/formato.js';
import { BandejaQueue, type ProcesarDeps, processItem } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';
import { CompraStore, recetaACompra } from '../src/compra.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const URL_RECETA = 'https://recetas.example/tortilla';
const PARRAFO = 'Una tortilla de patatas jugosa como la de la abuela, con cebolla pochada. '.repeat(
  40,
);
const HTML = `<html><head><title>Tortilla de patatas</title>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Tortilla de patatas',
  recipeYield: '4',
  recipeIngredient: ['6 huevos', '500 g de patatas', '1 cebolla', 'Sal', 'Aceite de oliva'],
})}</script></head><body><article><p>${PARRAFO}</p></article></body></html>`;
const ARTICULO = `<html><head><title>Mercados</title></head><body><article><p>${PARRAFO}</p></article></body></html>`;
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 7\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';

let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps13-bandeja-compra-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const deps = (html: string): ProcesarDeps => ({
  complete: async () => async () => REPLY,
  fetchRaw: async () => html,
  videoText: async () => ({ ok: false, reason: 'no' }),
});

async function procesada(url: string, html: string) {
  const { item } = store.add(CHAT, { kind: 'enlace', url }, NOV11, '2026-11-11');
  const r = await processItem(item, deps(html));
  store.saveResult(item.id, r, NOV11);
  const fresh = store.get(item.id);
  if (!fresh) throw new Error('sin cosa');
  return fresh;
}

describe('gaps-13: «🛒 A la compra» en la ficha de una receta de la bandeja (Muse)', () => {
  it('una página con ficha Recipe se marca como receta y su ficha lleva el botón', async () => {
    const item = await procesada(URL_RECETA, HTML);
    expect(item.extra.receta).toBe(5);
    const b = compraButton(item);
    expect(b?.label).toBe('🛒 A la compra');
    expect(cardButtons(item).map((x) => x.label)).toContain('🛒 A la compra');
    expect(commandFromCallback(b?.action ?? '')).toBe(`/bandeja compra ${item.id}`);
    // Ya vista: la receta sigue valiendo para la lista.
    store.setState(item.id, 'visto');
    const vista = store.get(item.id);
    expect(vista && cardButtons(vista).map((x) => x.label)).toContain('🛒 A la compra');
  });

  it('un artículo normal no lleva el botón', async () => {
    const item = await procesada('https://noticias.example/mercados', ARTICULO);
    expect(item.extra.receta).toBeUndefined();
    expect(compraButton(item)).toBeUndefined();
    expect(cardButtons(item).map((x) => x.label)).not.toContain('🛒 A la compra');
  });

  it('/bandeja compra N apunta los ingredientes en /compra (sin sal), y aparte del bucle de Telegram', async () => {
    const item = await procesada(URL_RECETA, HTML);
    expect(bandejaSlowSub(`compra ${item.id}`)).toBe(true);
    const compra = new CompraStore(join(dir, 'lista-compra.json'), 'telegram:default:111');
    const fetched: string[] = [];
    const progress: string[] = [];
    const reply = await bandejaCommand(`compra ${item.id}`, {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: CHAT,
      now: () => NOV11,
      progress: async (t) => {
        progress.push(t);
      },
      compra: (it) =>
        recetaACompra(compra, it.url ?? '', async (u) => {
          fetched.push(u);
          return HTML;
        }),
    });
    expect(fetched).toEqual([URL_RECETA]);
    expect(progress[0]).toContain('🛒 Apunto los ingredientes');
    expect(reply.text).toContain('«Tortilla de patatas»');
    expect(reply.text).toContain('apunto 4 ingredientes');
    const lista = compra.list().map((x) => x.text);
    expect(lista).toEqual(expect.arrayContaining(['6 huevos', '500 g de patatas', '1 cebolla']));
    expect(lista.join(' ')).not.toMatch(/\bsal\b/i);
    expect(reply.buttons?.length).toBeGreaterThan(0);
  });

  it('otra persona u otro número no toca nada', async () => {
    const item = await procesada(URL_RECETA, HTML);
    let llamado = false;
    const reply = await bandejaCommand(`compra ${item.id}`, {
      store,
      queue: new BandejaQueue(store, deps(HTML)),
      chatId: '999',
      now: () => NOV11,
      compra: async () => {
        llamado = true;
        return { text: 'x' };
      },
    });
    expect(llamado).toBe(false);
    expect(reply.text).toContain('No tengo la');
  });

  it('cli: la orden lleva su dep a recetaACompra, en la lista de este chat', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = cli.indexOf('const runBandejaCmd = async');
    const bloque = cli.slice(i, i + 2500);
    expect(bloque).toContain('compra: (item) =>');
    expect(bloque).toContain(
      "new CompraStore(join(paths.state, 'lista-compra.json'), chatKey(inbound))",
    );
  });
});
