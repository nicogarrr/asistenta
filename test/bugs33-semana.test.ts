import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDigestForTests,
  type DigestDeps,
  runDigestIfDue,
  WEEKLY_CATCHUP_DAYS,
} from '../src/bandeja/resumen.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-33 (11 nov 2026): «🏆 Tu semana en la bandeja» solo salía si el resumen corría un
// DOMINGO. Con el PC apagado el domingo a las 21:30 (o si Telegram fallaba justo con ese
// mensaje) la semana se perdía: el lunes ya no era domingo y nada lo recuperaba.

const CHAT = '111';
let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs33-semana-'));
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

describe('bandeja: el repaso de la semana no se pierde', () => {
  it('PC apagado el domingo: sale el lunes con el resumen de la noche', async () => {
    addDone(1, new Date('2026-11-12T10:00:00Z'), '2026-11-12'); // jueves
    const h = harness();
    // Domingo 15: el PC está apagado, no corre nada. Lunes 16, 21:30 en Madrid:
    h.at('2026-11-16T20:30:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(1);
    // Y no vuelve a salir el martes.
    h.at('2026-11-17T20:30:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(1);
  });

  it('si el mensaje de la semana falla el domingo, se reintenta (no se da por enviado)', async () => {
    addDone(1, new Date('2026-11-12T10:00:00Z'), '2026-11-12');
    let fail = true;
    const h = harness(() => fail);
    h.at('2026-11-15T20:30:00Z'); // domingo 21:30
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(0);
    fail = false;
    h.at('2026-11-15T20:35:00Z'); // antes de 10 min: no se insiste cada minuto
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(0);
    h.at('2026-11-15T20:45:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(1);
    h.at('2026-11-15T21:00:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(1);
  });

  it('el domingo normal sale una vez, y el lunes no se repite', async () => {
    addDone(1, new Date('2026-11-12T10:00:00Z'), '2026-11-12');
    const h = harness();
    h.at('2026-11-15T20:30:00Z');
    await runDigestIfDue(h.deps);
    h.at('2026-11-16T20:30:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(1);
  });

  it('si el PC estuvo apagado varios días, una semana ya vieja no se manda', async () => {
    addDone(1, new Date('2026-11-12T10:00:00Z'), '2026-11-12');
    const h = harness();
    const late = new Date(Date.UTC(2026, 10, 15 + WEEKLY_CATCHUP_DAYS + 1, 20, 30));
    h.at(late.toISOString());
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(0);
  });

  it('el domingo antes de la hora del resumen no sale', async () => {
    addDone(1, new Date('2026-11-12T10:00:00Z'), '2026-11-12');
    const h = harness();
    h.at('2026-11-15T09:00:00Z');
    await runDigestIfDue(h.deps);
    expect(h.weeklies()).toHaveLength(0);
  });
});
