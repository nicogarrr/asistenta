import { describe, expect, it, vi } from 'vitest';
import { createGoalTickExecute, type TickThread } from '../src/daemon/goal-tick.js';
import { createRoutineTask } from '../src/daemon/routine-task.js';
import type { Goal } from '../src/goals/store.js';
import type { RoutineRunContext } from '../src/routines.js';

type FakeThread = TickThread & { runs: string[]; notes: string[]; cleared: string[] };

function fakeThread(key: string, name: string, run?: (p: string) => Promise<unknown>): FakeThread {
  const t: FakeThread = {
    key,
    name,
    runs: [],
    notes: [],
    cleared: [],
    tail: Promise.resolve(),
    generation: 0,
    active: false,
    agent: {
      attachContext: (note: string) => {
        t.notes.push(note);
      },
      run: (async (p: string) => {
        t.runs.push(p);
        expect(t.active).toBe(true);
        if (run) return run(p);
        return { text: `hecho: ${p}`, error: null, toolCalls: 2 };
      }) as unknown as TickThread['agent']['run'],
    },
    gate: {
      clearSession: (k: string) => {
        t.cleared.push(k);
      },
    },
  };
  return t;
}

function harness(run?: (p: string) => Promise<unknown>) {
  const threads = new Map<string, FakeThread>();
  const calls: Array<[string, string, string]> = [];
  const sessions = {
    begun: [] as Array<[string, string, string | undefined]>,
    turns: [] as string[],
    ended: [] as string[],
    begin(scope: string, title: string, origin?: 'human' | 'goal-tick') {
      this.begun.push([scope, title, origin]);
      return `s${this.begun.length}`;
    },
    addTurn(_id: string, _role: string, text: string) {
      this.turns.push(text);
    },
    end(id: string, _summary: string) {
      this.ended.push(id);
    },
  };
  const actions = { record: vi.fn() };
  const deps = {
    threadFor: async (chatKey: string, name: string, label: string) => {
      calls.push([chatKey, name, label]);
      const key = `${chatKey}#${name}`;
      let t = threads.get(key);
      if (!t) {
        t = fakeThread(key, name, run);
        threads.set(key, t);
      }
      return t;
    },
    sessions,
    contextNoteFor: (t: FakeThread, prompt: string) => `nota ${t.key} ${prompt}`,
    safeRemember: (fn: () => void) => fn(),
  };
  return { threads, calls, sessions, actions, deps };
}

const goal = (scope: string) => ({ id: 'g1', title: 'Vigilar precio', scope }) as unknown as Goal;

describe('createGoalTickExecute (tick de objetivo del daemon)', () => {
  it('corre en el hilo dueño del objetivo, con nota de contexto, sesión goal-tick y registro', async () => {
    const h = harness();
    const exec = createGoalTickExecute({ ...h.deps, actions: h.actions });
    const r = await exec(goal('telegram:dm:42#viaje'), 'avanza');
    expect(r).toEqual({ text: 'hecho: avanza', error: null });
    expect(h.calls).toEqual([['telegram:dm:42', 'viaje', 'viaje']]);
    const t = h.threads.get('telegram:dm:42#viaje') as FakeThread;
    expect(t.notes).toEqual(['nota telegram:dm:42#viaje avanza']);
    expect(t.cleared).toEqual(['telegram:dm:42#viaje']);
    expect(t.active).toBe(false);
    expect(h.sessions.begun).toEqual([
      ['telegram:dm:42#viaje', '[objetivo] Vigilar precio', 'goal-tick'],
    ]);
    expect(h.sessions.ended).toEqual(['s1']);
    expect(h.actions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'objetivo-tick',
        target: 'viaje',
        result: 'ok',
        detail: '2 tools',
      }),
    );
  });

  it('el hilo main se crea con la etiqueta «principal»', async () => {
    const h = harness();
    await createGoalTickExecute({ ...h.deps, actions: h.actions })(
      goal('telegram:dm:42#main'),
      'x',
    );
    expect(h.calls[0]?.[2]).toBe('principal');
  });

  it('espera a la cola del hilo y /stop (generación) cancela el tick encolado', async () => {
    const h = harness();
    const exec = createGoalTickExecute({ ...h.deps, actions: h.actions });
    const t = await h.deps.threadFor('telegram:dm:42', 'main', 'principal');
    let release = () => {};
    t.tail = new Promise<void>((res) => {
      release = res;
    });
    const p = exec(goal('telegram:dm:42#main'), 'avanza');
    await Promise.resolve();
    expect(t.runs).toEqual([]);
    t.generation++;
    release();
    expect(await p).toEqual({ text: '', error: 'lo paraste tú antes de que empezara' });
    expect(t.runs).toEqual([]);
    expect(h.sessions.begun).toEqual([]);
  });

  it('si el agente lanza, devuelve el error, cierra la sesión y libera el hilo', async () => {
    const h = harness(async () => {
      throw new Error('modelo caído');
    });
    const exec = createGoalTickExecute({ ...h.deps, actions: h.actions });
    const r = await exec(goal('telegram:dm:42#main'), 'avanza');
    expect(r).toEqual({ text: '', error: 'modelo caído' });
    const t = h.threads.get('telegram:dm:42#main') as FakeThread;
    expect(t.active).toBe(false);
    expect(t.cleared).toHaveLength(1);
    expect(h.sessions.ended).toEqual(['s1']);
    expect(h.actions.record).not.toHaveBeenCalled();
    // la cola sigue viva para el siguiente turno
    await expect(t.tail).resolves.toBeDefined();
  });
});

const ctx = (scope: string) =>
  ({ scope, routine: { name: 'resumen' } }) as unknown as RoutineRunContext;

describe('createRoutineTask (tarea de rutina del daemon)', () => {
  it('scope sin chat: no hace nada', async () => {
    const h = harness();
    expect(await createRoutineTask(h.deps)('p', ctx('#main'))).toBe('');
    expect(h.calls).toEqual([]);
  });

  it('corre en el hilo del scope (main por defecto) y devuelve el texto del agente', async () => {
    const h = harness();
    const text = await createRoutineTask(h.deps)('resume el día', ctx('telegram:dm:7'));
    expect(text).toBe('hecho: resume el día');
    expect(h.calls).toEqual([['telegram:dm:7', 'main', 'principal']]);
    expect(h.sessions.begun).toEqual([['telegram:dm:7#main', '[rutina] resumen', 'goal-tick']]);
    expect(h.sessions.turns).toEqual(['hecho: resume el día']);
    const t = h.threads.get('telegram:dm:7#main') as FakeThread;
    expect(t.notes).toEqual(['nota telegram:dm:7#main resume el día']);
    expect(t.cleared).toEqual(['telegram:dm:7#main']);
  });

  it('un error del agente no impide devolver el texto', async () => {
    const h = harness(async () => ({ text: 'a medias', error: 'tiempo agotado' }));
    expect(await createRoutineTask(h.deps)('p', ctx('telegram:dm:7#x'))).toBe('a medias');
  });

  it('/stop entre encolar y correr: devuelve vacío sin ejecutar', async () => {
    const h = harness();
    const t = await h.deps.threadFor('telegram:dm:7', 'main', 'principal');
    let release = () => {};
    t.tail = new Promise<void>((res) => {
      release = res;
    });
    const p = createRoutineTask(h.deps)('p', ctx('telegram:dm:7'));
    await Promise.resolve();
    t.generation++;
    release();
    expect(await p).toBe('');
    expect(t.runs).toEqual([]);
  });
});
