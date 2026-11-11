import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeDigest } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps14-resumen-compra-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function cosa(url: string, extra: Record<string, unknown>) {
  const { item } = store.add(CHAT, { kind: 'enlace', url }, NOV11, '2026-11-11');
  store.saveResult(
    item.id,
    {
      title: 'Tortilla de patatas',
      verdict: 'ideas',
      score: 7,
      reason: 'Receta clásica.',
      ideas: ['a'],
      costMin: 3,
      costLabel: '📰 ~3 min de lectura',
      extra: { source: 'recetas.example', basis: 'texto', ...extra },
    },
    NOV11,
  );
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}

describe('gaps-14: «🛒 N compra» también en el resumen de la noche', () => {
  it('una receta lleva su línea y su botón; lo demás no', () => {
    const receta = cosa('https://recetas.example/tortilla', { receta: 5 });
    const normal = cosa('https://blog.example/post', {});
    const d = composeDigest([receta, normal], '2026-11-11', NOV11);
    expect(d.text).toContain(
      `   🛒 Receta: 5 ingredientes (🛒 ${receta.id} compra los apunta en /compra)`,
    );
    const compra = d.buttons.filter((b) => b.label.startsWith('🛒'));
    expect(compra.map((b) => b.label)).toEqual([`🛒 ${receta.id} compra`]);
    expect(commandFromCallback(compra[0]?.action ?? '')).toBe(`/bandeja compra ${receta.id}`);
  });

  it('con 1 ingrediente no es receta (como en la ficha)', () => {
    const una = cosa('https://recetas.example/sal', { receta: 1 });
    const d = composeDigest([una], '2026-11-11', NOV11);
    expect(d.text).not.toContain('🛒 Receta');
    expect(d.buttons.some((b) => b.label.startsWith('🛒'))).toBe(false);
  });
});
