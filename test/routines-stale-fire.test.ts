// Un temporizador de croner sobrevive hasta el siguiente sync(). Si la rutina se
// borra o se pausa en la base de datos sin que ese sync llegue (otro proceso, un
// camino que olvide llamarlo, una carrera con el disparo), el callback no puede
// ejecutar la copia vieja que capturó al registrarse.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:main:1';
let dir = '';
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T10:00:00Z'));
  dir = mkdtempSync(join(tmpdir(), 'pa-routines-stale-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function runnerCounting(): { runner: RoutineRunner; calls: () => number } {
  let n = 0;
  const runner = new RoutineRunner({
    store,
    timeoutMs: 5_000,
    run: async () => {
      n++;
    },
  });
  return { runner, calls: () => n };
}

describe('disparo de una rutina que ya no está viva', () => {
  it('control: una rutina viva dispara', async () => {
    store.saveRoutine({
      scope: SCOPE,
      name: 'trenes',
      kind: 'schedule',
      prompt: 'p',
      schedule: '* * * * *',
    });
    const { runner, calls } = runnerCounting();
    runner.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    runner.stop();
    expect(calls()).toBeGreaterThan(0);
  });

  it('borrada sin sync: no se ejecuta la copia vieja', async () => {
    store.saveRoutine({
      scope: SCOPE,
      name: 'trenes',
      kind: 'schedule',
      prompt: 'p',
      schedule: '* * * * *',
    });
    const { runner, calls } = runnerCounting();
    runner.start();
    store.deleteRoutine(SCOPE, 'trenes');
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    runner.stop();
    expect(calls()).toBe(0);
  });

  it('pausada sin sync: no se ejecuta', async () => {
    store.saveRoutine({
      scope: SCOPE,
      name: 'trenes',
      kind: 'schedule',
      prompt: 'p',
      schedule: '* * * * *',
    });
    const { runner, calls } = runnerCounting();
    runner.start();
    store.setRoutineEnabled(SCOPE, 'trenes', false);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    runner.stop();
    expect(calls()).toBe(0);
  });
});
