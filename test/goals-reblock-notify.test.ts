// Un bloqueo o una decisión que vuelve a plantearse tras reanudar es un episodio
// NUEVO: el aviso ya entregado del episodio anterior no puede silenciarlo, o el
// objetivo queda bloqueado en silencio para siempre (el runner no hace ticks de
// un objetivo bloqueado y Nico nunca se entera).
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts cargue
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { GoalNotifier } from '../src/goals/notify.js';
import { GoalRunner } from '../src/goals/runner.js';
import { GoalStore } from '../src/goals/store.js';

afterAll(() => {
  rmSync(FACTORY_TEST_STATE_DIR, { recursive: true, force: true });
});

const SCOPE = 'telegram:test:123#main';

function newDb(): DatabaseSync {
  return new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-goals-reblock-')), 'g.db'));
}

describe('aviso de un bloqueo repetido', () => {
  it('la misma decisión planteada de nuevo tras reanudar vuelve a llegar a Nico', async () => {
    const db = newDb();
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
    const notifier = new GoalNotifier({
      db,
      send: (_g, text) => {
        sent.push(text);
        return Promise.resolve(`m-${sent.length}`);
      },
      resolveGoal: (id) => goals.read(id),
    });
    const runner = new GoalRunner({
      goals,
      notifier,
      store: {
        getRoutine: () => null,
        deleteRoutine: () => true,
        markRoutineRun: () => {},
        listRoutines: () => [],
      },
      sync: () => {},
      dayKey: () => '2026-10-30',
      execute: () =>
        Promise.resolve({ text: '[decision] ¿Compro el de 120 €? sí / no', error: null }),
    });
    const name = `objetivo:${goal.id}`;

    await runner.tickByRoutineName(name);
    expect(goals.read(goal.id)?.status).toBe('blocked');
    expect(sent.length).toBe(1);

    // Nico contesta "espera" y el objetivo se reanuda.
    goals.resume(goal.id);
    // El siguiente tick vuelve a necesitar la misma decisión: nuevo bloqueo.
    await runner.tickByRoutineName(name);
    expect(goals.read(goal.id)?.status).toBe('blocked');
    expect(sent.length).toBe(2);
    expect(notifier.hasPending(goal.id)).toBe(false);
  });

  it('un hito repetido sigue deduplicándose (no se reenvía)', async () => {
    const db = newDb();
    const goals = new GoalStore({ db });
    const goal = goals.propose({
      scope: SCOPE,
      title: 'entradas',
      verbatim: 'avísame de las entradas',
      plan: [{ text: 'mirar', done: false }],
      cadence: '20 * * * *',
    });
    const sent: string[] = [];
    const notifier = new GoalNotifier({
      db,
      send: (_g, text) => {
        sent.push(text);
        return Promise.resolve('m');
      },
      resolveGoal: (id) => goals.read(id),
    });
    expect(await notifier.report(goal, 'hito', 'salen a la venta')).toBe('sent');
    expect(await notifier.report(goal, 'hito', 'salen a la venta')).toBe('duplicate');
    expect(sent.length).toBe(1);
  });
});
