// `/cron probar objetivo:<id>` con el objetivo en pausa decía «Lanzo… el resultado
// llegará a este chat» y luego el tick lo saltaba en silencio (goals/runner.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCronCommand } from '../src/cli.js';
import { Store } from '../src/db.js';
import type { Goal } from '../src/goals/store.js';
import { RoutineRunner } from '../src/routines.js';

describe('/cron probar objetivo:<id>', () => {
  let dir: string;
  let store: Store;
  let runner: RoutineRunner;
  const run = vi.fn(async () => {});
  const scope = 'telegram:bot:1#main';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-cron-goal-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run, timeoutMs: 5_000 });
    runner.start();
    store.saveRoutine({
      scope,
      name: 'objetivo:g1',
      kind: 'schedule',
      prompt: 'avanza el objetivo g1',
      schedule: '0 9 * * *',
    });
    run.mockClear();
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (status: Goal['status'] | null) => ({
    store,
    routineRunner: runner,
    threadKey: scope,
    chatKey: 'telegram:bot:1',
    goals: { read: (id: string) => (status && id === 'g1' ? ({ id, status } as Goal) : null) },
  });

  it('con el objetivo en pausa no promete una prueba: lo dice y no dispara', () => {
    const reply = runCronCommand(deps('paused'), 'probar objetivo:g1');
    expect(reply).toContain('en pausa');
    expect(reply).toContain('reanuda el objetivo g1');
    expect(reply).not.toContain('Lanzo');
    expect(runner.isRunning(scope, 'objetivo:g1')).toBe(false);
  });

  it('bloqueado, propuesto o borrado tampoco promete nada', () => {
    expect(runCronCommand(deps('blocked'), 'probar objetivo:g1')).toContain('bloqueado');
    expect(runCronCommand(deps('proposed'), 'probar objetivo:g1')).toContain('aprobación');
    expect(runCronCommand(deps(null), 'probar objetivo:g1')).toContain('ya no existe');
  });

  it('con el objetivo activo se lanza como siempre', () => {
    expect(runCronCommand(deps('active'), 'probar objetivo:g1')).toContain('Lanzo');
  });
});
