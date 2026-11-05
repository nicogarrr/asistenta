import { describe, expect, it, vi } from 'vitest';
import { createRoutineFire, lateNote, RoutineOutageError } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  scope: 'telegram:dm:42',
  name: 'informe',
  kind: 'schedule',
  params: null,
  steps: null,
  prompt: 'resume el correo',
  schedule: '0 8 * * *',
  enabled: true,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  lastRunAt: null,
  ...over,
});

/** Temporizadores a mano: `run()` dispara el siguiente reintento pendiente. */
function fakeLater() {
  const queue: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    queue,
    later: (fn: () => void, ms: number) => {
      const item = { fn, ms, cancelled: false };
      queue.push(item);
      return {
        cancel: () => {
          item.cancelled = true;
        },
      };
    },
    async run() {
      const item = queue.shift();
      if (item && !item.cancelled) item.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

function deps(runTask: () => Promise<string>, over = {}) {
  const t = fakeLater();
  return {
    t,
    d: {
      store: {} as Store,
      tickGoal: vi.fn(async () => {}),
      runTask: vi.fn(runTask),
      send: vi.fn(async (_chat: string, _text: string, _b?: unknown) => ({})),
      delivery: {
        get: () => ({ target: 'chat' as const, soloSiCambia: false }),
        commit: vi.fn(),
      } as never,
      outputDir: '/nonexistent/salidas',
      sync: vi.fn(),
      droppedRemindersPath: '/nonexistent/dropped.jsonl',
      later: t.later,
      ...over,
    },
  };
}

const outage = () => Promise.reject(new RoutineOutageError('TypeError: fetch failed'));

describe('rutinas sin red o con el modelo caído', () => {
  it('no manda «No devolvió respuesta»: reintenta y llega con retraso cuando vuelve', async () => {
    let calls = 0;
    const { d, t } = deps(() => (++calls < 3 ? outage() : Promise.resolve('3 correos nuevos')));
    const r = routine();
    await createRoutineFire(d)('meta', { scope: r.scope, routine: r });
    expect(d.send).not.toHaveBeenCalled();
    expect(t.queue.map((q) => q.ms)).toEqual([60_000]);
    await t.run();
    expect(d.send).not.toHaveBeenCalled();
    expect(t.queue.map((q) => q.ms)).toEqual([120_000]);
    await t.run();
    expect(d.runTask).toHaveBeenCalledTimes(3);
    expect(d.send).toHaveBeenCalledTimes(1);
    const text = String(d.send.mock.calls[0]?.[1]);
    expect(text).toMatch(
      /^⏰ informe \(con \d+ min de retraso: a su hora no había conexión con el modelo\)\n\n3 correos nuevos$/,
    );
  });

  it('tras 1, 2, 5, 10 y 15 min sin conexión avisa una vez en castellano', async () => {
    const { d, t } = deps(outage);
    const r = routine();
    await createRoutineFire(d)('meta', { scope: r.scope, routine: r });
    const waits: number[] = [];
    while (t.queue.length) {
      waits.push(t.queue[0]?.ms ?? 0);
      await t.run();
    }
    expect(waits).toEqual([60_000, 120_000, 300_000, 600_000, 900_000]);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0]?.[1]).toContain(
      'No la he podido hacer: lo he reintentado durante 33 min y no había conexión con el modelo',
    );
  });

  it('un disparo nuevo a su hora sustituye al reintento pendiente', async () => {
    const { d, t } = deps(outage);
    const r = routine();
    const fire = createRoutineFire(d);
    await fire('meta', { scope: r.scope, routine: r });
    await fire('meta', { scope: r.scope, routine: r });
    expect(t.queue[0]?.cancelled).toBe(true);
    expect(t.queue.filter((q) => !q.cancelled)).toHaveLength(1);
  });

  it('otros fallos no se reintentan, y PA_AUTO_RETRY=0 (lista vacía) tampoco', async () => {
    const a = deps(() => Promise.reject(new Error('boom')));
    const r = routine();
    await createRoutineFire(a.d)('meta', { scope: r.scope, routine: r });
    expect(a.t.queue).toHaveLength(0);
    expect(a.d.send).toHaveBeenCalledWith('42', '⏰ informe\n\nNo devolvió respuesta.');

    const b = deps(outage, { outageDelaysMs: [] });
    await createRoutineFire(b.d)('meta', { scope: r.scope, routine: r });
    expect(b.t.queue).toHaveLength(0);
    expect(b.d.send.mock.calls[0]?.[1]).toContain('No la he podido hacer');
  });

  it('la nota de retraso redondea a minutos', () => {
    expect(lateNote(30_000)).toBe(
      ' (con 1 min de retraso: a su hora no había conexión con el modelo)',
    );
    expect(lateNote(7 * 60_000)).toContain('7 min');
  });
});
