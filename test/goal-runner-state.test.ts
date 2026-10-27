import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalNotifier } from '../src/goals/notify.js';
import { GoalRunner, goalRoutineName } from '../src/goals/runner.js';
import { GoalStore } from '../src/goals/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-goal-state-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  const db = new DatabaseSync(path);
  const goals = new GoalStore({ db });
  const goal = goals.propose({
    scope: 'telegram:test#project',
    title: 'test',
    verbatim: 'test only',
    plan: [{ text: 'one', done: false }],
    cadence: '20 * * * *',
  });
  goals.activate(goal.id, null);
  const send = vi.fn(async () => 'message');
  const notifier = new GoalNotifier({ db, send, resolveGoal: (id) => goals.read(id) });
  const onDone = vi.fn();
  const store = {
    getRoutine: vi.fn(() => null),
    deleteRoutine: vi.fn(() => false),
    markRoutineRun: vi.fn(),
    listRoutines: vi.fn(() => []),
  };
  return { db, path, goals, goal, notifier, send, onDone, store };
}

describe('goal tick fresh lifecycle state', () => {
  it.each(['paused', 'cancelled'] as const)(
    'does not execute if %s during notification flush',
    async (status) => {
      const f = fixture();
      vi.spyOn(f.notifier, 'flush').mockImplementation(async () => {
        if (status === 'paused') f.goals.pause(f.goal.id);
        else f.goals.cancel(f.goal.id);
      });
      const execute = vi.fn(async () => ({ text: '[hecho] stale', error: null }));
      const runner = new GoalRunner({ ...f, sync: vi.fn(), execute });
      await runner.tickByRoutineName(goalRoutineName(f.goal.id));
      expect(execute).not.toHaveBeenCalled();
      expect(f.goals.read(f.goal.id)?.status).toBe(status);
      f.db.close();
    },
  );

  it.each(['paused', 'cancelled'] as const)(
    'does not overwrite %s with late completion',
    async (status) => {
      const f = fixture();
      const execute = vi.fn(async () => {
        if (status === 'paused') f.goals.pause(f.goal.id);
        else f.goals.cancel(f.goal.id);
        return { text: '[hecho] stale', error: null };
      });
      const runner = new GoalRunner({ ...f, sync: vi.fn(), execute });
      await runner.tickByRoutineName(goalRoutineName(f.goal.id));
      expect(f.goals.read(f.goal.id)?.status).toBe(status);
      expect(f.onDone).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      f.db.close();
    },
  );

  it('preserves scope, plan, block time and daily budget after reopening SQLite', () => {
    const f = fixture();
    f.goals.updatePlan(f.goal.id, [{ text: 'one', done: true, note: 'saved' }]);
    f.goals.noteTick(f.goal.id, 'decision', '2026-10-27');
    f.goals.block(f.goal.id, 'pending choice');
    const before = f.goals.read(f.goal.id);
    f.db.close();
    const reopenedDb = new DatabaseSync(f.path);
    const reopened = new GoalStore({ db: reopenedDb });
    expect(reopened.read(f.goal.id)).toEqual(before);
    expect(reopened.list('telegram:other#project')).toEqual([]);
    expect(reopened.list('telegram:test#project')).toHaveLength(1);
    reopenedDb.close();
  });
});
