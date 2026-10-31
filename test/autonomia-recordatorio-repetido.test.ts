import { describe, expect, it, vi } from 'vitest';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';
import { dueOfOneShot, isOneShotReminder, settleOneShot } from '../src/tools/reminder.js';

const pastilla: Routine = {
  id: 'r1',
  scope: 'telegram:dm:42',
  name: 'recordatorio: tomar la pastilla [0 9 * * *]',
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: 'tomar la pastilla',
  schedule: '0 9 * * *',
  enabled: true,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  lastRunAt: null,
};

function deps(send: () => Promise<unknown>) {
  const saved: Array<Pick<Routine, 'scope' | 'name' | 'prompt' | 'schedule'>> = [];
  const store = {
    saveRoutine: vi.fn((r: (typeof saved)[number]) => saved.push(r)),
    deleteRoutine: vi.fn(),
  } as unknown as Store;
  return {
    saved,
    d: {
      store,
      tickGoal: vi.fn(async () => {}),
      runTask: vi.fn(async () => 'x'),
      send: vi.fn(send),
      delivery: {
        get: () => ({ target: 'chat' as const, soloSiCambia: false }),
        commit: vi.fn(),
      } as never,
      outputDir: '/nonexistent/salidas',
      sync: vi.fn(),
      droppedRemindersPath: '/nonexistent/dropped.jsonl',
    },
  };
}

describe('recordatorio repetido sin conexión', () => {
  it('si el envío falla, queda un reintento puntual de ese aviso (no se pierde hasta mañana)', async () => {
    const { d, saved } = deps(async () => {
      throw new TypeError('fetch failed');
    });
    await createRoutineFire(d)('', { scope: pastilla.scope, routine: pastilla });
    expect(saved).toHaveLength(1);
    const parked = saved[0] as Routine;
    expect(isOneShotReminder(parked)).toBe(true);
    expect(parked.prompt).toBe('tomar la pastilla');
    expect(parked.scope).toBe('telegram:dm:42');
    expect(dueOfOneShot(parked.name)).not.toBeNull();
    expect(d.sync).toHaveBeenCalled();
    // El reintento sigue el camino de los puntuales: se reintenta y, pasada una
    // hora sin poder, se abandona (y se apunta).
    const due = dueOfOneShot(parked.name)?.getTime() ?? 0;
    const later = { saveRoutine: vi.fn(), deleteRoutine: vi.fn() };
    expect(settleOneShot(later, parked, false, due + 10 * 60_000)).toBe('retry');
    expect(settleOneShot(later, parked, false, due + 2 * 3_600_000)).toBe('dropped');
  });

  it('si el envío va bien, no deja nada aparcado', async () => {
    const { d, saved } = deps(async () => ({}));
    await createRoutineFire(d)('', { scope: pastilla.scope, routine: pastilla });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(0);
  });

  it('una rutina que trabaja (no recordatorio) no se aparca', async () => {
    const { d, saved } = deps(async () => {
      throw new TypeError('fetch failed');
    });
    const r = { ...pastilla, name: 'informe', prompt: 'resume el correo' };
    await createRoutineFire(d)('', { scope: r.scope, routine: r });
    expect(saved).toHaveLength(0);
  });
});
