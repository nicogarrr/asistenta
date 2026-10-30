import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCronCommand } from '../src/cli.js';
import { Store } from '../src/db.js';
import { goalRoutineName } from '../src/goals/runner.js';
import { RoutineRunner } from '../src/routines.js';

// /cron del|pausa|reanudar on `objetivo:<id>` moved the timer without the goal:
// a deleted/paused schedule left the goal `active` with no ticks, forever.
describe('/cron sobre la rutina de un objetivo', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  const NAME = goalRoutineName('g1');
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  const deps = () => ({ store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-goal-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    store.saveRoutine({
      scope: THREAD,
      name: NAME,
      kind: 'schedule',
      prompt: 'tick',
      schedule: '0 9 * * *',
    });
    runner.start();
  });

  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('del no borra la programación de un objetivo y explica cómo cancelarlo', () => {
    const reply = runCronCommand(deps(), `del ${NAME}`);
    expect(store.getRoutine(THREAD, NAME)).toBeTruthy();
    expect(runner.status().some((s) => s.name === NAME)).toBe(true);
    expect(reply).toContain('es la programación de un objetivo');
    expect(reply).toContain('cancela el objetivo g1');
  });

  it('pausa no deja el objetivo activo sin ticks', () => {
    const reply = runCronCommand(deps(), `pausa ${NAME}`);
    expect(store.getRoutine(THREAD, NAME)?.enabled).toBe(true);
    expect(reply).toContain('pausa el objetivo g1');
  });

  it('reanudar no da ticks a un objetivo pausado', () => {
    store.setRoutineEnabled(THREAD, NAME, false);
    const reply = runCronCommand(deps(), `reanudar ${NAME}`);
    expect(store.getRoutine(THREAD, NAME)?.enabled).toBe(false);
    expect(reply).toContain('reanuda el objetivo g1');
  });

  it('una rutina normal se sigue borrando', () => {
    store.saveRoutine({
      scope: THREAD,
      name: 'resumen',
      kind: 'schedule',
      prompt: 'x',
      schedule: '0 8 * * *',
    });
    expect(runCronCommand(deps(), 'del resumen')).toContain('borrada');
    expect(store.getRoutine(THREAD, 'resumen')).toBeFalsy();
  });
});
