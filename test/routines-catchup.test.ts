// F1: una rutina programada cuyo disparo cayó con el PC apagado o dormido se
// recupera UNA vez dentro de su ventana de gracia (mitad del periodo, 2 min–2 h).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db.js';
import { findMissedSlot, RoutineRunner } from '../src/routines.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:main:1';
let dir = '';
let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'pa-routines-catchup-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Rutina creada y ejecutada por última vez en `lastRun` (hora del sistema falsa). */
function seed(schedule: string, createdAt: string, lastRun: string | null): void {
  vi.setSystemTime(new Date(createdAt));
  store.saveRoutine({ scope: SCOPE, name: 'resumen', kind: 'schedule', prompt: 'p', schedule });
  if (lastRun) {
    vi.setSystemTime(new Date(lastRun));
    store.markRoutineRun(SCOPE, 'resumen');
  }
}

function runner(catchUp = true): { r: RoutineRunner; prompts: string[] } {
  const prompts: string[] = [];
  const r = new RoutineRunner({
    store,
    timeoutMs: 5_000,
    catchUp,
    run: async (prompt) => {
      prompts.push(prompt);
    },
  });
  return { r, prompts };
}

// TZ=Europe/Madrid (CI). 30-oct-2026 ya es CET (UTC+1): 08:00 Madrid = 07:00Z.
describe('F1: recuperar disparos perdidos de rutinas', () => {
  it('apagado de 07:55 a 08:30: al arrancar dispara una vez, marcado con retraso', async () => {
    seed('0 8 * * *', '2026-10-28T10:00:00Z', '2026-10-29T07:00:02Z');
    vi.setSystemTime(new Date('2026-10-30T07:30:00Z'));
    const { r, prompts } = runner();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/con retraso/);
    expect(prompts[0]).toMatch(/08:00/);
  });

  it('apagado hasta las 10:30 (gracia de 2 h superada): no dispara y queda como perdida', async () => {
    seed('0 8 * * *', '2026-10-28T10:00:00Z', '2026-10-29T07:00:02Z');
    vi.setSystemTime(new Date('2026-10-30T09:30:00Z'));
    const { r, prompts } = runner();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    const status = r.status();
    r.stop();
    expect(prompts).toHaveLength(0);
    expect(status[0]?.missed).toBe('2026-10-30T07:00:00.000Z');
  });

  it('dos reinicios seguidos nunca disparan dos veces el mismo hueco', async () => {
    seed('0 8 * * *', '2026-10-28T10:00:00Z', '2026-10-29T07:00:02Z');
    vi.setSystemTime(new Date('2026-10-30T07:30:00Z'));
    const a = runner();
    a.r.start();
    await vi.advanceTimersByTimeAsync(0);
    a.r.stop();
    const b = runner();
    b.r.start();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    b.r.stop();
    expect(a.prompts.length + b.prompts.length).toBe(1);
  });

  it('cada 5 min con 1 h apagado: solo el último hueco, no 12', async () => {
    seed('*/5 * * * *', '2026-10-28T10:00:00Z', '2026-10-30T08:00:30Z');
    vi.setSystemTime(new Date('2026-10-30T09:02:00Z'));
    const { r, prompts } = runner();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    expect(prompts).toHaveLength(1);
    expect(
      findMissedSlot(
        '*/5 * * * *',
        new Date('2026-10-30T08:00:30Z'),
        new Date('2026-10-30T09:02:00Z'),
      )?.slot.toISOString(),
    ).toBe('2026-10-30T09:00:00.000Z');
  });

  it('el PC se despierta sin reiniciar: croner o la comprobación periódica, pero una sola vez', async () => {
    seed('0 8 * * *', '2026-10-28T10:00:00Z', '2026-10-29T07:00:02Z');
    vi.setSystemTime(new Date('2026-10-30T06:00:00Z'));
    const { r, prompts } = runner();
    r.start();
    // Simula una suspensión: el reloj salta sin que corran los temporizadores.
    vi.setSystemTime(new Date('2026-10-30T07:20:00Z'));
    await vi.advanceTimersByTimeAsync(61_000);
    r.stop();
    // croner recalcula al despertar y dispara él; la comprobación periódica ve
    // lastRunAt al día y no añade un segundo disparo.
    expect(prompts).toHaveLength(1);
  });

  it('una rutina recién creada no recupera huecos de antes de existir', async () => {
    seed('0 8 * * *', '2026-10-30T06:59:40Z', null);
    vi.setSystemTime(new Date('2026-10-30T07:10:00Z'));
    const { r, prompts } = runner();
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    expect(prompts).toHaveLength(0);
  });

  it('sin catchUp (por defecto en la clase) no cambia nada', async () => {
    seed('0 8 * * *', '2026-10-28T10:00:00Z', '2026-10-29T07:00:02Z');
    vi.setSystemTime(new Date('2026-10-30T07:30:00Z'));
    const { r, prompts } = runner(false);
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    r.stop();
    expect(prompts).toHaveLength(0);
  });
});
