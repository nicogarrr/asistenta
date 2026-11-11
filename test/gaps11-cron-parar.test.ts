import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCronCommand } from '../src/daemon/cron-command.js';
import type { TickThread } from '../src/daemon/goal-tick.js';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import { createRoutineTask } from '../src/daemon/routine-task.js';
import { RoutineStoppedError, RoutineStops } from '../src/daemon/rutina-parar.js';
import { type Routine, Store } from '../src/db.js';
import { formatHistory } from '../src/routine-history.js';
import { type RoutineRunContext, RoutineRunner } from '../src/routines.js';

type FakeThread = TickThread & { runs: string[]; aborted: number };

function harness(run: (t: FakeThread) => Promise<unknown>) {
  const threads = new Map<string, FakeThread>();
  const deps = {
    threadFor: async (chatKey: string, name: string) => {
      const key = `${chatKey}#${name}`;
      let t = threads.get(key);
      if (!t) {
        const thread: FakeThread = {
          key,
          name,
          runs: [],
          aborted: 0,
          tail: Promise.resolve(),
          generation: 0,
          active: false,
          agent: {
            attachContext: () => {},
            run: (async (p: string) => {
              thread.runs.push(p);
              return run(thread);
            }) as unknown as TickThread['agent']['run'],
          },
          gate: { clearSession: () => {} },
        };
        t = thread;
        threads.set(key, t);
      }
      return t;
    },
    sessions: { begin: () => 's', addTurn: () => {}, end: () => {} },
    contextNoteFor: () => '',
    safeRemember: (fn: () => void) => fn(),
  };
  return { threads, deps };
}

const ctx = (scope: string, name = 'informe') =>
  ({ scope, routine: { name } }) as unknown as RoutineRunContext;

describe('/cron parar: cortar solo la rutina en marcha (Hermes)', () => {
  it('una rutina corriendo se aborta y no devuelve lo escrito a medias', async () => {
    const stops = new RoutineStops();
    let finish: (v: unknown) => void = () => {};
    const h = harness(
      () =>
        new Promise((res) => {
          finish = res;
        }),
    );
    const task = createRoutineTask(h.deps, {
      stops,
      abortThread: (t) => {
        t.aborted++;
        finish({ text: 'a medias', error: 'aborted' });
      },
    });
    const p = task('trabaja', ctx('telegram:dm:7'));
    await vi.waitFor(() => expect(h.threads.get('telegram:dm:7#main')?.runs.length).toBe(1));
    expect(stops.isActive('telegram:dm:7', 'informe')).toBe(true);
    expect(stops.stop('telegram:dm:7', 'informe')).toBe('parada');
    await expect(p).rejects.toBeInstanceOf(RoutineStoppedError);
    expect(h.threads.get('telegram:dm:7#main')?.aborted).toBe(1);
    expect(stops.isActive('telegram:dm:7', 'informe')).toBe(false);
  });

  it('en cola (esperando turno del hilo): no llega a empezar ni aborta la conversación', async () => {
    const stops = new RoutineStops();
    const h = harness(async () => ({ text: 'hecho', error: null }));
    const t = await h.deps.threadFor('telegram:dm:7', 'main');
    let release = () => {};
    t.tail = new Promise<void>((res) => {
      release = res;
    });
    const abortThread = vi.fn();
    const p = createRoutineTask(h.deps, { stops, abortThread })('trabaja', ctx('telegram:dm:7'));
    await Promise.resolve();
    await Promise.resolve();
    expect(stops.stop('telegram:dm:7', 'informe')).toBe('en-cola');
    release();
    await expect(p).rejects.toBeInstanceOf(RoutineStoppedError);
    expect(t.runs).toEqual([]);
    expect(abortThread).not.toHaveBeenCalled();
  });

  it('sin parar, todo igual y el registro se vacía', async () => {
    const stops = new RoutineStops();
    const h = harness(async () => ({ text: 'informe listo', error: null }));
    const text = await createRoutineTask(h.deps, { stops, abortThread: vi.fn() })(
      'p',
      ctx('telegram:dm:7'),
    );
    expect(text).toBe('informe listo');
    expect(stops.stop('telegram:dm:7', 'informe')).toBe('no-en-curso');
  });

  it('el disparo de una rutina parada no manda nada y el historial dice «parada por ti»', async () => {
    const recorded: Array<{ entrega: string; ok: boolean; salida: string }> = [];
    const send = vi.fn(async () => ({}));
    const fire = createRoutineFire({
      store: {} as Store,
      tickGoal: vi.fn(async () => {}),
      runTask: vi.fn(async () => {
        throw new RoutineStoppedError('informe');
      }),
      send,
      delivery: {
        get: () => ({ target: 'chat' as const, soloSiCambia: false }),
        commit: vi.fn(),
      } as never,
      outputDir: '/nonexistent/salidas',
      sync: vi.fn(),
      droppedRemindersPath: '/nonexistent/dropped.jsonl',
      history: {
        record: (_s: string, _n: string, run: { entrega: string; ok: boolean; salida: string }) =>
          recorded.push(run),
      } as never,
    });
    const r: Routine = {
      id: 'r1',
      scope: 'telegram:dm:42',
      name: 'informe',
      kind: 'schedule',
      params: null,
      steps: null,
      prompt: 'resume el correo',
      schedule: '0 9 * * *',
      enabled: true,
      createdAt: '2026-11-11T08:00:00.000Z',
      updatedAt: '2026-11-11T08:00:00.000Z',
      lastRunAt: null,
    };
    await fire('', { scope: r.scope, routine: r });
    expect(send).not.toHaveBeenCalled();
    expect(recorded.map((x) => x.entrega)).toEqual(['parada']);
    const line = formatHistory('informe', [{ at: Date.now(), ms: 2000, ...recorded[0] } as never]);
    expect(line).toContain('⏹');
    expect(line).toContain('parada por ti');
  });
});

describe('/cron parar (comando, con Store real)', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  let stops: RoutineStops;
  const deps = () => ({ store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT, stops });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps11-parar-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    stops = new RoutineStops();
    for (const name of ['resumen', 'noticias']) {
      store.saveRoutine({
        scope: THREAD,
        name,
        kind: 'schedule',
        prompt: name,
        schedule: '0 8 * * *',
      });
    }
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('para la nombrada, aborta su turno y dice que sigue programada', () => {
    const h = stops.begin(THREAD, 'resumen');
    const abort = vi.fn();
    h.started(abort);
    const reply = runCronCommand(deps(), 'parar resumen');
    expect(reply).toContain('⏹ Rutina "resumen" parada');
    expect(reply).toContain('Sigue programada');
    expect(reply).toContain('/cron pausa resumen');
    expect(abort).toHaveBeenCalledTimes(1);
    expect(h.stopped).toBe(true);
    expect(store.getRoutine(THREAD, 'resumen')?.enabled).toBe(true);
  });

  it('sin nombre: la única en marcha; ninguna → lo dice; varias → pregunta', () => {
    expect(runCronCommand(deps(), 'parar')).toBe('Ahora mismo no hay ninguna rutina en marcha.');
    const a = stops.begin(THREAD, 'noticias');
    expect(runCronCommand(deps(), 'para')).toContain('cancelada antes de empezar');
    expect(a.stopped).toBe(true);
    stops.begin(THREAD, 'resumen');
    stops.begin(THREAD, 'noticias');
    expect(runCronCommand(deps(), 'parar')).toContain('¿Qué rutina paro?');
  });

  it('una que no está en marcha o que no existe', () => {
    expect(runCronCommand(deps(), 'parar Resumen')).toContain('no está en marcha ahora mismo');
    expect(runCronCommand(deps(), 'parar inventada')).toContain('No tengo ninguna rutina llamada');
  });

  it('sin registro de paradas: dice cómo parar todo', () => {
    expect(
      runCronCommand(
        { store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT },
        'parar resumen',
      ),
    ).toContain('/stop');
  });
});
