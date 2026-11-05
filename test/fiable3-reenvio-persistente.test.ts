import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoutineFire, RESUME_MIN_WAIT_MS } from '../src/daemon/routine-fire.js';
import { RoutineResendQueue } from '../src/daemon/routine-resend-queue.js';
import type { Routine, Store } from '../src/db.js';

// #2036 reenviaba el informe que Telegram no aceptó, pero solo desde memoria: si el
// PC o el daemon se reiniciaban con el informe de las 8:00 pendiente, se perdía.
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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(path: string, sendOk: () => boolean) {
  const t = fakeLater();
  const commit = vi.fn();
  const d = {
    store: {} as Store,
    tickGoal: vi.fn(async () => {}),
    runTask: vi.fn(async () => '3 correos nuevos'),
    send: vi.fn(async (_chat: string, _text: string, _b?: unknown) => {
      if (!sendOk()) throw new Error('Network request for sendMessage failed!');
      return {};
    }),
    delivery: { get: () => ({ target: 'chat' as const, soloSiCambia: false }), commit } as never,
    outputDir: '/nonexistent/salidas',
    sync: vi.fn(),
    droppedRemindersPath: '/nonexistent/dropped.jsonl',
    later: t.later,
    resendQueue: new RoutineResendQueue(path),
  };
  return { d, t, commit };
}

function tmpQueue(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-reenvio-'));
  dirs.push(dir);
  return join(dir, 'rutinas-reenvio.json');
}

describe('informe de rutina pendiente de reenvío tras un reinicio', () => {
  it('queda en disco y el arranque siguiente lo reenvía sin volver a trabajar', async () => {
    const path = tmpQueue();
    const r = routine();
    const antes = setup(path, () => false);
    await createRoutineFire(antes.d)('meta', { scope: r.scope, routine: r });
    const guardado = JSON.parse(readFileSync(path, 'utf8'));
    expect(guardado).toHaveLength(1);
    expect(guardado[0]).toMatchObject({
      routine: 'informe',
      chatId: '42',
      body: '3 correos nuevos',
    });

    // Reinicio: otro proceso, otro createRoutineFire, la misma cola en disco.
    const despues = setup(path, () => true);
    const fire = createRoutineFire(despues.d);
    expect(fire.resumePending()).toBe(1);
    // Le quedaba ~1 min de su primera espera (se guardó hace unos ms).
    expect(despues.t.queue).toHaveLength(1);
    expect(despues.t.queue[0]?.ms).toBeGreaterThan(55_000);
    expect(despues.t.queue[0]?.ms).toBeLessThanOrEqual(60_000);
    await despues.t.run();
    expect(despues.d.runTask).not.toHaveBeenCalled();
    expect(despues.d.send).toHaveBeenCalledTimes(1);
    expect(String(despues.d.send.mock.calls[0]?.[1])).toMatch(
      /^⏰ informe \(con \d+ min de retraso: a su hora no se pudo enviar\)\n\n3 correos nuevos$/,
    );
    expect(despues.commit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it('lo que ya tocaba sale a los 30 s del arranque; uno de hace más de un día se descarta', async () => {
    const path = tmpQueue();
    const base = { scope: 'telegram:dm:42', chatId: '42', body: 'x', hash: 'h', attempt: 1 };
    writeFileSync(
      path,
      JSON.stringify([
        { ...base, routine: 'informe', firstAt: Date.now() - 3_600_000, dueAt: Date.now() - 1000 },
        { ...base, routine: 'viejo', firstAt: Date.now() - 2 * 86_400_000, dueAt: 0 },
      ]),
    );
    const { d, t } = setup(path, () => true);
    expect(createRoutineFire(d).resumePending()).toBe(1);
    expect(t.queue.map((q) => q.ms)).toEqual([RESUME_MIN_WAIT_MS]);
    expect(
      JSON.parse(readFileSync(path, 'utf8')).map((e: { routine: string }) => e.routine),
    ).toEqual(['informe']);
  });

  it('un disparo nuevo a su hora lo quita de la cola', async () => {
    const path = tmpQueue();
    let ok = false;
    const r = routine();
    const { d } = setup(path, () => ok);
    const fire = createRoutineFire(d);
    await fire('meta', { scope: r.scope, routine: r });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
    ok = true;
    await fire('meta', { scope: r.scope, routine: r });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it('un fichero roto no tumba nada', () => {
    const path = tmpQueue();
    writeFileSync(path, '{no es json');
    expect(new RoutineResendQueue(path).all()).toEqual([]);
  });
});
