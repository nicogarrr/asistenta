import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalNotifier } from '../src/goals/notify.js';
import { GOAL_OUTCOME_OUTAGE, GoalRunner, goalRoutineName } from '../src/goals/runner.js';
import { GoalStore, MAX_TICKS_PER_DAY } from '../src/goals/store.js';

// Un objetivo que tocaba con el PC sin internet (o el modelo caído) gastaba el cupo
// del día y avisaba «falló en su último intento» por cada corte suelto; el aviso
// llegaba al volver la red, cuando ya iba bien.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(results: Array<{ text: string; error: string | null }>) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-goal-outage-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'g.db'));
  const goals = new GoalStore({ db });
  const goal = goals.propose({
    scope: 'telegram:test#main',
    title: 'vuelo barato',
    verbatim: 'búscame un vuelo barato',
    plan: [{ text: 'buscar', done: false }],
    cadence: '*/30 * * * *',
  });
  goals.activate(goal.id, null);
  const sent: string[] = [];
  const notifier = new GoalNotifier({
    db,
    send: async (_g, text) => {
      sent.push(text);
      return `m-${sent.length}`;
    },
    resolveGoal: (id) => goals.read(id),
  });
  const store = {
    getRoutine: vi.fn(() => null),
    deleteRoutine: vi.fn(() => false),
    listRoutines: vi.fn(() => []),
  };
  let i = 0;
  const execute = vi.fn(
    async (): Promise<{ text: string; error: string | null }> =>
      results[Math.min(i++, results.length - 1)] ?? { text: '', error: null },
  );
  const runner = new GoalRunner({
    goals,
    notifier,
    store,
    sync: vi.fn(),
    execute,
    dayKey: () => '2026-11-05',
  });
  const tick = () => runner.tickByRoutineName(goalRoutineName(goal.id));
  const read = () => {
    const g = goals.read(goal.id);
    if (!g) throw new Error('goal');
    return g;
  };
  return { tick, read, sent, execute, db };
}

const OUTAGE = { text: '', error: 'TypeError: fetch failed (getaddrinfo ENOTFOUND api.example)' };
const OK = { text: '[progreso] mirando precios', error: null };

describe('objetivos sin red', () => {
  it('un corte suelto no avisa ni gasta el cupo del día', async () => {
    const f = fixture([OUTAGE, OK]);
    await f.tick();
    expect(f.sent).toEqual([]);
    expect(f.read().ticksToday).toBe(0);
    expect(f.read().lastOutcome).toBe(GOAL_OUTCOME_OUTAGE);
    // Vuelve la red: el siguiente intento cuenta y sigue en silencio.
    await f.tick();
    expect(f.sent).toEqual([]);
    expect(f.read().ticksToday).toBe(1);
    expect(f.read().lastOutcome).toBe('progreso');
    f.db.close();
  });

  it('si el corte sigue en el siguiente intento, avisa en claro (una vez)', async () => {
    const f = fixture([OUTAGE]);
    await f.tick();
    await f.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain('vuelo barato');
    expect(f.sent[0]).not.toContain('fetch failed');
    await f.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.read().ticksToday).toBe(0);
    f.db.close();
  });

  it('una noche entera sin red no deja el objetivo sin cupo para el día', async () => {
    const f = fixture([...Array.from({ length: MAX_TICKS_PER_DAY + 3 }, () => OUTAGE), OK]);
    for (let n = 0; n < MAX_TICKS_PER_DAY + 3; n++) await f.tick();
    expect(f.read().ticksToday).toBe(0);
    const before = f.execute.mock.calls.length;
    await f.tick();
    expect(f.execute.mock.calls.length).toBe(before + 1);
    expect(f.read().lastOutcome).toBe('progreso');
    f.db.close();
  });

  it('un error que no es de red sigue avisando a la primera y cuenta', async () => {
    const f = fixture([{ text: '', error: 'la herramienta devolvió algo raro' }]);
    await f.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.read().ticksToday).toBe(1);
    expect(f.read().lastOutcome).toBe('error');
    f.db.close();
  });
});
