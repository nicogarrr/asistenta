import { describe, expect, it, vi } from 'vitest';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import type { Routine, Store } from '../src/db.js';

// Una rutina (el informe de las 8:00) que hacía su trabajo pero no se podía enviar
// (Telegram sin red un rato) se perdía: solo quedaba «routine send failed» en el log.
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

function setup(sendOk: (n: number) => boolean) {
  const t = fakeLater();
  let n = 0;
  const commit = vi.fn();
  const d = {
    store: {} as Store,
    tickGoal: vi.fn(async () => {}),
    runTask: vi.fn(async () => '3 correos nuevos'),
    send: vi.fn(async (_chat: string, _text: string, _b?: unknown) => {
      if (!sendOk(++n)) throw new Error('Network request for sendMessage failed!');
      return {};
    }),
    delivery: { get: () => ({ target: 'chat' as const, soloSiCambia: false }), commit } as never,
    outputDir: '/nonexistent/salidas',
    sync: vi.fn(),
    droppedRemindersPath: '/nonexistent/dropped.jsonl',
    later: t.later,
  };
  return { d, t, commit };
}

describe('rutina hecha que Telegram no aceptó', () => {
  it('se reenvía la misma salida más tarde, sin volver a trabajar, y avisa del retraso', async () => {
    const { d, t, commit } = setup((n) => n >= 3);
    const r = routine();
    await createRoutineFire(d)('meta', { scope: r.scope, routine: r });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(t.queue.map((q) => q.ms)).toEqual([60_000]);
    await t.run();
    expect(t.queue.map((q) => q.ms)).toEqual([120_000]);
    await t.run();
    expect(d.send).toHaveBeenCalledTimes(3);
    expect(d.runTask).toHaveBeenCalledTimes(1);
    expect(String(d.send.mock.calls[2]?.[1])).toMatch(
      /^⏰ informe \(con \d+ min de retraso: a su hora no se pudo enviar\)\n\n3 correos nuevos$/,
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(t.queue).toEqual([]);
  });

  it('un disparo nuevo a su hora sustituye al reenvío pendiente', async () => {
    let fail = true;
    const { d, t } = setup(() => !fail);
    const r = routine();
    const fire = createRoutineFire(d);
    await fire('meta', { scope: r.scope, routine: r });
    expect(t.queue[0]?.cancelled).toBe(false);
    fail = false;
    await fire('meta', { scope: r.scope, routine: r });
    expect(t.queue[0]?.cancelled).toBe(true);
    await t.run();
    expect(d.send).toHaveBeenCalledTimes(2);
  });

  it('si nunca vuelve la red, lo deja tras 1, 2, 5, 10 y 15 min', async () => {
    const { d, t } = setup(() => false);
    const r = routine();
    await createRoutineFire(d)('meta', { scope: r.scope, routine: r });
    const esperas: number[] = [];
    while (t.queue.length) {
      esperas.push(t.queue[0]?.ms ?? 0);
      await t.run();
    }
    expect(esperas).toEqual([60_000, 120_000, 300_000, 600_000, 900_000]);
    expect(d.send).toHaveBeenCalledTimes(6);
  });
});
