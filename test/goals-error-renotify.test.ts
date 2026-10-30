import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ERROR_RENOTIFY_COOLDOWN_MS, GoalNotifier } from '../src/goals/notify.js';
import { GoalStore } from '../src/goals/store.js';

// Un error de tick con el mismo texto se deduplicaba para siempre: Nico oía el
// primer fallo y nunca que el objetivo seguía fallando días después.
describe('aviso de error repetido de un objetivo', () => {
  function setup() {
    const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-goal-err-')), 'g.db'));
    const goals = new GoalStore({ db });
    const goal = goals.propose({
      scope: 'telegram:test:123#main',
      title: 'vuelo',
      verbatim: 'busca un vuelo',
      plan: [{ text: 'buscar', done: false }],
      cadence: '20 * * * *',
    });
    goals.activate(goal.id, null);
    let now = Date.parse('2026-10-30T10:00:00Z');
    const sent: string[] = [];
    const notifier = new GoalNotifier({
      db,
      send: (_g, text) => {
        sent.push(text);
        return Promise.resolve(`m-${sent.length}`);
      },
      resolveGoal: (id) => goals.read(id),
      now: () => now,
    });
    const g = goals.read(goal.id);
    if (!g) throw new Error('goal');
    return {
      notifier,
      g,
      sent,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('el mismo error dentro del enfriamiento no se repite', async () => {
    const { notifier, g, sent, advance } = setup();
    expect(await notifier.report(g, 'error', 'timeout del modelo')).toBe('sent');
    advance(60 * 60_000);
    expect(await notifier.report(g, 'error', 'timeout del modelo')).toBe('duplicate');
    expect(sent).toHaveLength(1);
  });

  it('el mismo error pasado el enfriamiento vuelve a avisar', async () => {
    const { notifier, g, sent, advance } = setup();
    await notifier.report(g, 'error', 'timeout del modelo');
    advance(ERROR_RENOTIFY_COOLDOWN_MS + 1);
    expect(await notifier.report(g, 'error', 'timeout del modelo')).toBe('sent');
    expect(sent).toHaveLength(2);
    // Y el enfriamiento cuenta desde la última entrega, no desde la primera.
    advance(60 * 60_000);
    expect(await notifier.report(g, 'error', 'timeout del modelo')).toBe('duplicate');
  });

  it('un hito repetido sigue siendo un duplicado aunque pase el tiempo', async () => {
    const { notifier, g, sent, advance } = setup();
    await notifier.report(g, 'hito', 'encontrado vuelo a 90 €');
    advance(ERROR_RENOTIFY_COOLDOWN_MS * 3);
    expect(await notifier.report(g, 'hito', 'encontrado vuelo a 90 €')).toBe('duplicate');
    expect(sent).toHaveLength(1);
  });
});
