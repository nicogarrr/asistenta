import { describe, expect, it, vi } from 'vitest';
import {
  chatIdOfScope,
  createRoutineFire,
  deliverMissedThenStart,
} from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';

const routine = (over: Partial<Routine>): Routine => ({
  id: 'r1',
  scope: 'telegram:dm:42',
  name: 'informe',
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: 'resume el correo',
  schedule: '0 9 * * *',
  enabled: true,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  lastRunAt: null,
  ...over,
});

function deps(over: Partial<Parameters<typeof createRoutineFire>[0]> = {}) {
  return {
    store: {} as Store,
    tickGoal: vi.fn(async () => {}),
    runTask: vi.fn(async () => 'hecho'),
    send: vi.fn(async () => ({})),
    delivery: {
      get: () => ({ target: 'chat' as const, soloSiCambia: false }),
      commit: vi.fn(),
    } as never,
    outputDir: '/nonexistent/salidas',
    sync: vi.fn(),
    droppedRemindersPath: '/nonexistent/dropped.jsonl',
    ...over,
  };
}

describe('chatIdOfScope', () => {
  it('saca el chat de un scope con o sin hilo', () => {
    expect(chatIdOfScope('telegram:dm:42')).toBe('42');
    expect(chatIdOfScope('telegram:dm:42#viaje')).toBe('42');
    expect(chatIdOfScope('local')).toBe('');
    expect(chatIdOfScope('')).toBe('');
  });
});

describe('createRoutineFire (disparo de rutinas del daemon)', () => {
  it('un tick de objetivo ejecuta el objetivo y no manda ningún mensaje', async () => {
    const d = deps();
    const r = routine({ name: 'objetivo:abc' });
    await createRoutineFire(d)('meta', { scope: r.scope, routine: r });
    expect(d.tickGoal).toHaveBeenCalledWith('objetivo:abc');
    expect(d.send).not.toHaveBeenCalled();
    expect(d.runTask).not.toHaveBeenCalled();
  });

  it('sin chat en el scope no hace nada', async () => {
    const d = deps();
    const r = routine({ scope: 'local' });
    await createRoutineFire(d)('meta', { scope: 'local', routine: r });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.runTask).not.toHaveBeenCalled();
  });

  it('una rutina programada trabaja con SU prompt (no con los metadatos) y responde en su chat', async () => {
    const d = deps();
    const r = routine({});
    await createRoutineFire(d)('metadatos del runner', {
      scope: 'telegram:dm:42#hilo',
      routine: r,
    });
    expect(d.runTask).toHaveBeenCalledWith('resume el correo', expect.anything());
    expect(d.send).toHaveBeenCalledWith('42', '⏰ Rutina "informe":\n\nhecho');
    expect(d.sync).not.toHaveBeenCalled();
  });

  it('si la rutina falla o no devuelve nada, avisa igualmente con «No devolvió respuesta.»', async () => {
    const d = deps({
      runTask: vi.fn(async () => {
        throw new Error('modelo caído');
      }),
    });
    const r = routine({});
    await createRoutineFire(d)('', { scope: r.scope, routine: r });
    expect(d.send).toHaveBeenCalledWith('42', '⏰ Rutina "informe":\n\nNo devolvió respuesta.');
  });

  it('un recordatorio recurrente solo avisa, sin ejecutar nada', async () => {
    const d = deps();
    const r = routine({ name: 'recordatorio: regar', prompt: 'regar las plantas' });
    await createRoutineFire(d)('', { scope: r.scope, routine: r });
    expect(d.runTask).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledWith('42', '⏰ Recordatorio: regar las plantas');
  });

  it('un fallo de Telegram no rompe el disparo', async () => {
    const d = deps({
      send: vi.fn(async () => {
        throw new Error('telegram caído');
      }),
    });
    const r = routine({ name: 'recordatorio: regar' });
    await expect(createRoutineFire(d)('', { scope: r.scope, routine: r })).resolves.toBeUndefined();
  });
});

describe('deliverMissedThenStart (arranque del planificador)', () => {
  it('arranca el planificador aunque la recuperación falle', async () => {
    const start = vi.fn();
    const store = {
      listRoutines: () => {
        throw new Error('db rota');
      },
    } as unknown as Store;
    await deliverMissedThenStart({ store, send: vi.fn(), start });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('arranca el planificador sin recordatorios pendientes', async () => {
    const start = vi.fn();
    const store = { listRoutines: () => [] } as unknown as Store;
    await deliverMissedThenStart({ store, send: vi.fn(), start });
    expect(start).toHaveBeenCalledTimes(1);
  });
});
