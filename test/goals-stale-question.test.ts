// Un aviso de bloqueo o decisión que no llegó (Telegram caído) se reintenta en
// cada tick. Si Nico ya reanudó o canceló el objetivo, esa pregunta está
// resuelta: entregarla tarde le pide decidir algo que ya no espera nadie.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts cargue
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { GoalNotifier } from '../src/goals/notify.js';
import { GoalStore } from '../src/goals/store.js';

afterAll(() => {
  rmSync(FACTORY_TEST_STATE_DIR, { recursive: true, force: true });
});

const SCOPE = 'telegram:test:123#main';

function setup() {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-goals-stale-')), 'g.db'));
  const goals = new GoalStore({ db });
  const goal = goals.propose({
    scope: SCOPE,
    title: 'vuelo',
    verbatim: 'busca un vuelo barato',
    plan: [{ text: 'buscar', done: false }],
    cadence: '20 * * * *',
  });
  goals.activate(goal.id, null);
  const sent: string[] = [];
  let online = false;
  const notifier = new GoalNotifier({
    db,
    send: (_g, text) => {
      if (!online) return Promise.reject(new Error('telegram caído'));
      sent.push(text);
      return Promise.resolve(`m-${sent.length}`);
    },
    resolveGoal: (id) => goals.read(id),
  });
  return {
    goals,
    goal,
    sent,
    notifier,
    goOnline: () => {
      online = true;
    },
  };
}

describe('aviso pendiente de una pregunta ya resuelta', () => {
  for (const kind of ['bloqueo', 'decision'] as const) {
    it(`${kind}: no se entrega tras reanudar el objetivo`, async () => {
      const { goals, goal, sent, notifier, goOnline } = setup();
      goals.block(goal.id, '¿Compro el de 120 €?');
      expect(await notifier.report(goal, kind, '¿Compro el de 120 €?')).toBe('pending');
      await new Promise((r) => setTimeout(r, 5));
      goals.resume(goal.id);
      goOnline();
      await notifier.flushAll();
      expect(sent).toEqual([]);
      expect(notifier.hasPending(goal.id)).toBe(false);
    });
  }

  it('no se entrega tras cancelar el objetivo', async () => {
    const { goals, goal, sent, notifier, goOnline } = setup();
    goals.block(goal.id, 'falta la tarjeta');
    await notifier.report(goal, 'bloqueo', 'falta la tarjeta');
    goals.cancel(goal.id);
    goOnline();
    await notifier.flush(goals.read(goal.id) ?? goal);
    expect(sent).toEqual([]);
    expect(notifier.hasPending(goal.id)).toBe(false);
  });

  it('sigue entregándose mientras el objetivo continúa bloqueado', async () => {
    const { goals, goal, sent, notifier, goOnline } = setup();
    goals.block(goal.id, 'falta la tarjeta');
    await notifier.report(goal, 'bloqueo', 'falta la tarjeta');
    goOnline();
    await notifier.flushAll();
    expect(sent.length).toBe(1);
    expect(notifier.hasPending(goal.id)).toBe(false);
  });

  it('un hito pendiente sí se entrega aunque el objetivo se haya reanudado', async () => {
    const { goals, goal, sent, notifier, goOnline } = setup();
    await notifier.report(goal, 'hito', 'encontrado a 90 €');
    goals.pause(goal.id);
    goals.resume(goal.id);
    goOnline();
    await notifier.flushAll();
    expect(sent.length).toBe(1);
  });
});
