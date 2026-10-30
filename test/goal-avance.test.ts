// objetivo action=avance: solo registra avance real, en un objetivo en marcha.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts cargue
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { type Goal, GoalStore } from '../src/goals/store.js';
import { createGoalTool } from '../src/tools/goal.js';

afterAll(() => {
  rmSync(FACTORY_TEST_STATE_DIR, { recursive: true, force: true });
});

const SCOPE = 'telegram:test:123#main';

function setup(): {
  goals: GoalStore;
  goal: Goal;
  run: (args: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
} {
  const goals = new GoalStore({
    db: new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-goal-avance-')), 'g.db')),
  });
  const goal = goals.propose({
    scope: SCOPE,
    title: 'mudanza',
    verbatim: 'organiza la mudanza',
    plan: [
      { text: 'pedir presupuestos', done: false },
      { text: 'elegir empresa', done: false },
      { text: 'reservar fecha', done: false },
    ],
    cadence: '20 * * * *',
  });
  const tool = createGoalTool({
    goals,
    scopeOf: () => SCOPE,
    store: { saveRoutine: () => ({}) as never, deleteRoutine: () => true },
    sync: () => {},
    workstreams: { create: () => 'w', update: () => {}, forget: () => {} },
    humanRepliedAfter: () => true,
  });
  const run = async (args: Record<string, unknown>) => {
    const r = await tool.execute('c', args as never);
    return {
      isError: r.isError,
      text: r.content.map((c) => ('text' in c ? c.text : '')).join('\n'),
    };
  };
  return { goals, goal, run };
}

const doneSteps = (goals: GoalStore, id: string): number =>
  goals.read(id)?.plan.filter((s) => s.done).length ?? -1;

describe('objetivo avance', () => {
  it('un paso no entero es un error, no un falso «marcado como hecho»', async () => {
    const { goals, goal, run } = setup();
    goals.activate(goal.id, null);
    const r = await run({ action: 'avance', id: goal.id, paso: 1.5 });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('marcado como hecho');
    expect(doneSteps(goals, goal.id)).toBe(0);
  });

  it('un objetivo cumplido no registra avance', async () => {
    const { goals, goal, run } = setup();
    goals.activate(goal.id, null);
    goals.complete(goal.id);
    const r = await run({ action: 'avance', id: goal.id, paso: 3 });
    expect(r.isError).toBe(true);
    expect(doneSteps(goals, goal.id)).toBe(0);
  });

  it('un objetivo cancelado no registra avance', async () => {
    const { goals, goal, run } = setup();
    goals.activate(goal.id, null);
    goals.cancel(goal.id);
    const r = await run({ action: 'avance', id: goal.id, paso: 2 });
    expect(r.isError).toBe(true);
    expect(doneSteps(goals, goal.id)).toBe(0);
  });

  it('control: un objetivo activo marca su paso', async () => {
    const { goals, goal, run } = setup();
    goals.activate(goal.id, null);
    const r = await run({ action: 'avance', id: goal.id, paso: 2, nota: 'Mudanzas Pepe' });
    expect(r.isError).toBeFalsy();
    expect(goals.read(goal.id)?.plan[1]).toMatchObject({ done: true, note: 'Mudanzas Pepe' });
  });
});
