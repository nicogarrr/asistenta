import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeDigest, MAX_DIGEST_CHAFF_ACTION_ITEMS } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
let dir = '';
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-resumen-paja-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function paja(url: string, title: string, extra: Record<string, unknown> = {}) {
  const { item } = store.add(CHAT, { kind: 'enlace', url }, NOV11, '2026-11-11');
  store.saveResult(
    item.id,
    {
      title,
      verdict: 'paja',
      score: 2,
      reason: 'Nada nuevo.',
      ideas: [],
      costMin: 3,
      costLabel: '📰 ~3 min de lectura',
      extra: { source: 'x.example', basis: 'texto', ...extra },
    },
    NOV11,
  );
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}

const EVENTO = { evento: { nombre: 'Junta', inicio: '2026-11-20T09:30:00+01:00', lugar: 'IFEMA' } };

describe('gaps-15: «📅 / 🛒» también en la paja (⚪) del resumen', () => {
  it('una receta y un evento ⚪ llevan su botón y su fecha; la paja normal, no', () => {
    const receta = paja('https://recetas.example/tortilla', 'Tortilla', { receta: 5 });
    const evento = paja('https://eventos.example/junta', 'Junta de accionistas', EVENTO);
    const normal = paja('https://blog.example/post', 'Post');
    const d = composeDigest([receta, evento, normal], '2026-11-11', NOV11);
    const labels = d.buttons.map((b) => b.label);
    expect(labels).toContain(`🛒 ${receta.id} compra`);
    expect(labels).toContain(`📅 ${evento.id} calendario`);
    expect(labels.some((l) => l.includes(` ${normal.id} `))).toBe(false);
    // Ni ✅/⏭️/🗑️ ni 📖 para la paja: eso sigue siendo 🧹.
    expect(labels.some((l) => l.startsWith('📖'))).toBe(false);
    expect(labels).toContain('🧹 Quitar la paja');
    const cal = d.buttons.find((b) => b.label.startsWith('📅'));
    expect(commandFromCallback(cal?.action ?? '')).toBe(`/bandeja calendario ${evento.id}`);
    // La fecha del evento se ve también en la línea de la paja.
    const i = d.text.split('\n').findIndex((l) => l.startsWith(`#${evento.id} `));
    expect(d.text.split('\n')[i + 1]).toMatch(/^ {3}📅 .*20 nov/);
  });

  it('un evento ⚪ que ya pasó no lleva botón ni línea', () => {
    const pasado = paja('https://eventos.example/vieja', 'Vieja', {
      evento: { nombre: 'Vieja', inicio: '2026-11-01T09:30:00+01:00' },
    });
    const d = composeDigest([pasado], '2026-11-11', NOV11);
    expect(d.buttons.some((b) => b.label.startsWith('📅'))).toBe(false);
  });

  it('como mucho MAX_DIGEST_CHAFF_ACTION_ITEMS cosas ⚪ con botón', () => {
    const items = Array.from({ length: 7 }, (_, n) =>
      paja(`https://recetas.example/r${n}`, `Receta ${n}`, { receta: 3 }),
    );
    const d = composeDigest(items, '2026-11-11', NOV11);
    expect(d.buttons.filter((b) => b.label.startsWith('🛒')).length).toBe(
      MAX_DIGEST_CHAFF_ACTION_ITEMS,
    );
  });
});
