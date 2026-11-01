import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalNotifier } from '../src/goals/notify.js';
import { GoalRunner, goalRoutineName } from '../src/goals/runner.js';
import { GoalStore } from '../src/goals/store.js';
import { WorkstreamStore } from '../src/memory/workstreams.js';
import { createGoalTool } from '../src/tools/goal.js';

vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const scope = 'telegram:test:123#main';
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const goals = new GoalStore({ db });
  const workstreams = new WorkstreamStore({ db });
  const goal = goals.propose({
    scope,
    title: 'Preparar viaje',
    verbatim: 'buscar opciones',
    plan: [
      { text: 'Comparar trenes', done: false },
      { text: 'Elegir hotel', done: false },
    ],
    cadence: '20 * * * *',
  });
  const store = {
    saveRoutine: vi.fn(),
    deleteRoutine: vi.fn(),
    getRoutine: vi.fn(),
    markRoutineRun: vi.fn(),
    listRoutines: vi.fn(() => []),
  };
  const tool = createGoalTool({
    goals,
    workstreams,
    scopeOf: () => scope,
    store,
    sync: vi.fn(),
    humanRepliedAfter: () => true,
  });
  const notifier = new GoalNotifier({
    db,
    send: async () => 'sent',
    resolveGoal: (id) => goals.read(id),
  });
  return { db, goals, workstreams, goal, store, tool, notifier };
}
describe('durable goal -> prompt workstream lifecycle', () => {
  it('sets the first pending step immediately on activation', async () => {
    const f = fixture();
    await f.tool.execute('a', { action: 'activar', id: f.goal.id });
    expect(f.workstreams.index(scope)).toContain('siguiente: Comparar trenes');
  });
  it('pausing removes active status and resuming restores it and its next step', async () => {
    const f = fixture();
    await f.tool.execute('a', { action: 'activar', id: f.goal.id });
    await f.tool.execute('p', { action: 'pausar', id: f.goal.id });
    expect(f.workstreams.active(scope)).toHaveLength(0);
    expect(f.workstreams.index(scope)).toContain('[pausado]');
    expect(f.workstreams.index(scope)).toContain('no ejecutar');
    await f.tool.execute('r', { action: 'reanudar', id: f.goal.id });
    expect(f.workstreams.active(scope)).toHaveLength(1);
    expect(f.workstreams.index(scope)).toContain('siguiente: Comparar trenes');
  });
  it.each(['bloqueo', 'decision'])(
    'projects a runner %s without authorizing resume',
    async (kind) => {
      const f = fixture();
      await f.tool.execute('a', { action: 'activar', id: f.goal.id });
      const runner = new GoalRunner({
        ...f,
        sync: vi.fn(),
        execute: async () => ({ text: `[${kind}] Falta elegir fecha`, error: null }),
      });
      await runner.tickByRoutineName(goalRoutineName(f.goal.id));
      expect(f.goals.read(f.goal.id)?.status).toBe('blocked');
      expect(f.workstreams.active(scope)).toHaveLength(0);
      expect(f.workstreams.index(scope)).toContain('Esperando respuesta del usuario:');
      expect(f.workstreams.index(scope)).toContain('Falta elegir fecha');
      await f.tool.execute('advance', { action: 'avance', id: f.goal.id, paso: 1 });
      expect(f.workstreams.index(scope)).toContain('Esperando respuesta del usuario:');
      await f.tool.execute('r', { action: 'reanudar', id: f.goal.id });
      expect(f.workstreams.index(scope)).toContain('siguiente: Elegir hotel');
    },
  );
  it('keeps paused-only fronts visible to context instead of dropping them as no active work', async () => {
    // buildContextNote lives in src/daemon/context-note.ts (P2 move out of cli.ts).
    const mod = await readFile(new URL('../src/daemon/context-note.ts', import.meta.url), 'utf8');
    const start = mod.indexOf('export function buildContextNote(');
    expect(start).toBeGreaterThan(-1);
    const context = mod.slice(start);
    expect(context).not.toContain('workstreams?.active(thread.key)');
    expect(context).toContain("ws !== 'Sin frentes de trabajo abiertos.'");
  });
});
