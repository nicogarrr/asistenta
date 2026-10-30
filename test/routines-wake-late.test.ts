// croner mantiene su temporizador durante una suspensión del PC y, al despertar,
// dispara el hueco atrasado. Antes salía sin etiqueta y sin límite de gracia (un
// resumen de las 08:00 a las 18:00 como si fuera puntual). Ahora: «con retraso»
// dentro de la gracia (mitad del periodo, 2 min–2 h) y nada fuera de ella.
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
  dir = mkdtempSync(join(tmpdir(), 'pa-routines-wake-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 08:00 Madrid el 30-oct-2026 = 07:00Z. Rutina antigua, último disparo ayer. */
async function sleepThroughEight(wakeAt: string): Promise<string[]> {
  vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
  store.saveRoutine({
    scope: SCOPE,
    name: 'resumen',
    kind: 'schedule',
    prompt: 'p',
    schedule: '0 8 * * *',
  });
  vi.setSystemTime(new Date('2026-10-29T07:00:02Z'));
  store.markRoutineRun(SCOPE, 'resumen');
  vi.setSystemTime(new Date('2026-10-30T06:59:00Z'));
  const prompts: string[] = [];
  const r = new RoutineRunner({
    store,
    timeoutMs: 5_000,
    catchUp: false,
    run: async (prompt) => {
      prompts.push(prompt);
    },
  });
  r.start();
  await vi.advanceTimersByTimeAsync(1_000);
  // El PC duerme: el reloj salta sin que corran los temporizadores.
  vi.setSystemTime(new Date(wakeAt));
  await vi.advanceTimersByTimeAsync(65_000);
  r.stop();
  return prompts;
}

describe('rutinas: disparo de croner al despertar de una suspensión', () => {
  it('a tiempo: sin etiqueta de retraso', async () => {
    const prompts = await sleepThroughEight('2026-10-30T06:59:01Z');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toMatch(/con retraso/);
  });

  it('despierta 30 min tarde (dentro de la gracia de 2 h): una vez, marcada con retraso', async () => {
    const prompts = await sleepThroughEight('2026-10-30T07:30:00Z');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/con retraso/);
    expect(prompts[0]).toMatch(/08:00/);
  });

  it('despierta a las 18:00 (gracia superada): no la ejecuta como si fuera puntual', async () => {
    const prompts = await sleepThroughEight('2026-10-30T17:00:00Z');
    expect(prompts).toHaveLength(0);
  });
});
