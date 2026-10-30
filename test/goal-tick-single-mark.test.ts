import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db.js';
import { GoalNotifier } from '../src/goals/notify.js';
import { GoalRunner, goalRoutineName } from '../src/goals/runner.js';
import { GoalStore } from '../src/goals/store.js';

// Cada tick de objetivo se registraba dos veces: el RoutineRunner marca la
// ejecución al dispararla y el GoalRunner la volvía a marcar al terminar,
// moviendo last_run_at al final de un tick largo.
describe('tick de objetivo: una sola marca de ejecución', () => {
  it('el GoalRunner no vuelve a marcar la rutina (ya la marca el RoutineRunner)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-goal-mark-'));
    const store = new Store(join(dir, 'db.sqlite'));
    const db = new DatabaseSync(join(dir, 'g.db'));
    const goals = new GoalStore({ db });
    const goal = goals.propose({
      scope: 'telegram:test:1#main',
      title: 'vuelo',
      verbatim: 'busca un vuelo',
      plan: [{ text: 'buscar', done: false }],
      cadence: '20 * * * *',
    });
    goals.activate(goal.id, null);
    const name = goalRoutineName(goal.id);
    store.saveRoutine({
      scope: goal.scope,
      name,
      kind: 'schedule',
      prompt: 'tick',
      schedule: '20 * * * *',
    });
    const mark = vi.spyOn(store, 'markRoutineRun');
    const execute = vi.fn(async () => ({ text: '[progreso] mirando', error: null }));
    const runner = new GoalRunner({
      goals,
      notifier: new GoalNotifier({
        db,
        send: async () => 'm',
        resolveGoal: (id) => goals.read(id),
      }),
      store,
      sync: () => {},
      dayKey: () => '2026-10-30',
      execute,
    });
    await runner.tickByRoutineName(name);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mark).not.toHaveBeenCalled();
    store.close();
  });
});
