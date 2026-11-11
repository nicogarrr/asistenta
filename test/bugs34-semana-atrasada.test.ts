import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDigestForTests, type DigestDeps, runDigestIfDue } from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-34 (sobre #2302): el repaso atrasado (PC apagado el domingo, sale el lunes) cogía
// «7 + días de retraso» hasta AHORA, así que contaba también lo del lunes, que vuelve a
// salir en el repaso del domingo siguiente: la misma cosa en dos semanas.

const CHAT = '111';
let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs34-semana-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
  _resetDigestForTests();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function addDone(n: number, at: Date, day: string) {
  const { item } = store.add(CHAT, { kind: 'enlace', url: `https://a.com/${n}` }, at, day);
  store.saveResult(
    item.id,
    {
      title: `Cosa ${n}`,
      verdict: 'imprescindible',
      score: 8,
      reason: 'porque sí',
      ideas: ['idea'],
      costMin: 5,
      costLabel: '📰 5 min',
      extra: { source: 'web' },
    },
    at,
  );
  return item.id;
}

function harness(failWeekly = () => false) {
  const sent: string[] = [];
  let now = new Date('2026-11-12T20:30:00Z');
  const deps: DigestDeps = {
    store,
    now: () => now,
    owner: () => CHAT,
    send: async (_c, text) => {
      if (text.startsWith('🏆') && failWeekly()) throw new Error('Telegram 502');
      sent.push(text);
      return true;
    },
    env: {},
  };
  return {
    deps,
    sent,
    weeklies: () => sent.filter((t) => t.startsWith('🏆')),
    at: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe('el repaso atrasado cuenta solo su semana', () => {
  it('lo del lunes no sale en el repaso atrasado del lunes, sí en el del domingo siguiente', async () => {
    addDone(1, new Date('2026-11-12T10:00:00Z'), '2026-11-12'); // jueves 12
    addDone(2, new Date('2026-11-16T09:00:00Z'), '2026-11-16'); // lunes 16, por la mañana
    const h = harness();
    // Domingo 15 con el PC apagado; el lunes 16 a las 21:30 sale el repaso atrasado.
    h.at('2026-11-16T20:30:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(1);
    expect(h.weeklies()[0]).toContain('Cosa 1');
    expect(h.weeklies()[0]).not.toContain('Cosa 2');
    // Domingo 22, 21:30: el repaso de esa semana sí la cuenta.
    h.at('2026-11-22T20:30:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(2);
    expect(h.weeklies()[1]).toContain('Cosa 2');
    expect(h.weeklies()[1]).not.toContain('Cosa 1');
  });
});
