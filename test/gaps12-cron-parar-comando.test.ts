import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_PROMPT_PREFIX,
  commandHash,
  fireCommandRoutine,
  runCommand,
  type SpawnLike,
} from '../src/command-routine.js';
import { runCronCommand } from '../src/daemon/cron-command.js';
import { Latidos } from '../src/daemon/latido.js';
import { createRoutineFire } from '../src/daemon/routine-fire.js';
import { RoutineStops, runStoppable } from '../src/daemon/rutina-parar.js';
import { type Routine, Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

/** Un hijo falso que no termina hasta que lo matan. */
function hangingChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter & { setEncoding: () => void };
    kill: (sig?: string) => boolean;
  };
  child.pid = 4242;
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stdout = stream();
  child.stderr = stream();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', null));
    return true;
  });
  return child;
}

describe('/cron parar en rutinas de comando (antes: «no se puede cortar a medias»)', () => {
  it('runCommand: al abortar mata el proceso y lo marca como parado (Linux)', async () => {
    const child = hangingChild();
    const ac = new AbortController();
    const p = runCommand(
      { argv: ['node', 'largo.js'], cwd: '.', timeoutMs: 60_000, signal: ac.signal },
      (() => child) as unknown as SpawnLike,
      'linux',
    );
    ac.abort();
    const r = await p;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(r.stopped).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('runCommand: en Windows mata el árbol entero con taskkill /T', async () => {
    const child = hangingChild();
    const calls: string[][] = [];
    const spawnImpl = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'taskkill.exe') {
        setImmediate(() => child.emit('close', 1));
        return hangingChild();
      }
      return child;
    }) as unknown as SpawnLike;
    const ac = new AbortController();
    const p = runCommand(
      { argv: ['saldo.bat'], cwd: '.', timeoutMs: 60_000, signal: ac.signal },
      spawnImpl,
      'win32',
    );
    ac.abort();
    const r = await p;
    expect(calls).toContainEqual(['taskkill.exe', '/F', '/T', '/PID', '4242']);
    expect(r.stopped).toBe(true);
  });

  it('runCommand: ya abortado, ni lo lanza', async () => {
    const spawnImpl = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const r = await runCommand(
      { argv: ['x'], cwd: '.', timeoutMs: 1000, signal: ac.signal },
      spawnImpl as unknown as SpawnLike,
      'linux',
    );
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(r.stopped).toBe(true);
  });

  it('runCommand: un programa real (node) que se cuelga se corta al momento', async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runCommand({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.stopped).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('runStoppable + fireCommandRoutine: /cron parar lo corta y no hay texto a medias', async () => {
    const stops = new RoutineStops();
    const child = hangingChild();
    const spec = { argv: ['node', 'saldo.js'], cwd: '.', timeoutMs: 60_000 };
    const store = {
      get: () => ({
        ...spec,
        schedule: '0 8 * * *',
        approvedHash: commandHash(spec),
        createdAt: '2026-11-11T08:00:00.000Z',
      }),
    };
    const p = runStoppable(stops, 'telegram:dm:7#main', 'saldo', (signal) =>
      fireCommandRoutine(
        store,
        { scope: 'telegram:dm:7#main', name: 'saldo', schedule: '0 8 * * *' },
        { enabled: true, signal, spawnImpl: (() => child) as unknown as SpawnLike },
      ),
    );
    expect(stops.isActive('telegram:dm:7#main', 'saldo')).toBe(true);
    expect(stops.stop('telegram:dm:7#main', 'saldo')).toBe('parada');
    const out = await p;
    expect(out.stopped).toBe(true);
    expect(stops.isActive('telegram:dm:7#main', 'saldo')).toBe(false);
  });

  it('el disparo de una rutina de comando parada no manda nada y apunta «parada»', async () => {
    const recorded: string[] = [];
    const send = vi.fn(async () => ({}));
    const fire = createRoutineFire({
      store: {} as Store,
      tickGoal: vi.fn(async () => {}),
      runTask: vi.fn(async () => 'nunca'),
      fireCommand: async () => ({
        body: 'Parada por ti con /cron parar.',
        failed: false,
        stopped: true,
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
        record: (_s: string, _n: string, run: { entrega: string }) => recorded.push(run.entrega),
      } as never,
    });
    const r: Routine = {
      id: 'r1',
      scope: 'telegram:dm:42',
      name: 'saldo',
      kind: 'schedule',
      params: null,
      steps: null,
      prompt: `${COMMAND_PROMPT_PREFIX}saldo`,
      schedule: '0 8 * * *',
      enabled: true,
      createdAt: '2026-11-11T08:00:00.000Z',
      updatedAt: '2026-11-11T08:00:00.000Z',
      lastRunAt: null,
    };
    await fire('', { scope: r.scope, routine: r });
    expect(send).not.toHaveBeenCalled();
    expect(recorded).toEqual(['parada']);
  });
});

describe('/cron parar <rutina de comando> (con Store real)', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-gaps12-parar-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    store.saveRoutine({
      scope: THREAD,
      name: 'saldo',
      kind: 'schedule',
      prompt: `${COMMAND_PROMPT_PREFIX}saldo`,
      schedule: '0 8 * * *',
    });
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ya no contesta «no se puede cortar»: la para de verdad', () => {
    const stops = new RoutineStops();
    const h = stops.begin(THREAD, 'saldo');
    const abort = vi.fn();
    h.started(abort);
    const reply = runCronCommand(
      { store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT, stops },
      'parar saldo',
    );
    expect(reply).not.toContain('no se puede cortar');
    expect(reply).toContain('⏹ Rutina "saldo" parada');
    expect(abort).toHaveBeenCalledTimes(1);
  });
});

describe('«deja de vigilar» a media comprobación corta ese turno (latidos)', () => {
  it('parar un latido mientras comprueba llama a abortCheck; parado en reposo, no', async () => {
    let finish: (t: string) => void = () => {};
    const abortCheck = vi.fn((_l: unknown) => finish('a medias'));
    const send = vi.fn(async () => ({}));
    const latidos = new Latidos({
      run: () =>
        new Promise<string>((res) => {
          finish = res;
        }),
      send,
      abortCheck,
      later: () => ({ cancel: () => {} }),
    });
    const l = latidos.start('telegram:dm:7', '7', 'si vuelve internet');
    if (typeof l === 'string') throw new Error(l);
    const tick = latidos.tick(l.id);
    await Promise.resolve();
    expect(latidos.stop('telegram:dm:7')).toHaveLength(1);
    await tick;
    expect(abortCheck).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    const l2 = latidos.start('telegram:dm:7', '7', 'el paquete');
    if (typeof l2 === 'string') throw new Error(l2);
    expect(latidos.stop('telegram:dm:7', 'paquete').map((x) => x.id)).toEqual([l2.id]);
    expect(abortCheck).toHaveBeenCalledTimes(1);
  });
});
