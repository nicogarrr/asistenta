import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releerCosa } from '../src/bandeja/releer.js';
import { BandejaStore } from '../src/bandeja/store.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const RECETA_HTML = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'Recipe',
  name: 'Tortilla',
  recipeIngredient: ['4 huevos', '500 g de patatas', '1 cebolla'],
})}</script></head><body>x</body></html>`;

let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs37-releer-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const resultado = (extra: Record<string, unknown>) => ({
  title: 'Tortilla de patatas',
  verdict: 'ideas' as const,
  score: 6,
  reason: 'Buena receta.',
  ideas: [],
  costMin: 2,
  costLabel: '📰 ~2 min de lectura',
  extra,
});

describe('bugs-37: «🔄 Releer» no pisa lo que se guardó mientras bajaba la página', () => {
  it('lo guardado durante el fetch (autor, temas) se queda, y se añade la receta', async () => {
    const { item } = store.add(CHAT, { kind: 'enlace', url: 'https://receta.example/t' }, NOV11, '2026-11-01');
    store.saveResult(item.id, resultado({ source: 'receta.example', basis: 'texto' }), NOV11);
    const viejo = store.get(item.id);
    if (!viejo) throw new Error('sin cosa');
    // Mientras se baja la página (hasta 30 s), la cosa se vuelve a juzgar y trae autor y temas.
    const fetchPagina = async () => {
      store.saveResult(
        item.id,
        resultado({ source: 'receta.example', basis: 'texto', author: 'Karlos', tags: ['cocina'] }),
        NOV11,
      );
      return RECETA_HTML;
    };
    const r = await releerCosa(store, viejo, fetchPagina, NOV11);
    expect(typeof r).not.toBe('string');
    const ahora = store.get(item.id);
    expect(ahora?.extra.receta).toBe(3);
    expect(ahora?.extra.author).toBe('Karlos');
    expect(ahora?.extra.tags).toEqual(['cocina']);
  });
});
