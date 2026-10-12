// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que permissions.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import type { Routine } from '../src/db.js';
import {
  GoalNotifier,
  formatGoalMessage,
  goalNotifyTarget,
  notifyKey,
} from '../src/goals/notify.js';
import {
  GoalRunner,
  buildTickPrompt,
  goalRoutineName,
  isGoalRoutine,
  parseOutcome,
} from '../src/goals/runner.js';
import {
  GoalStore,
  MAX_ACTIVE_GOALS,
  MAX_PROPOSED_GOALS,
  MAX_TICKS_PER_DAY,
  type Goal,
  splitGoalScope,
} from '../src/goals/store.js';
import { SessionStore } from '../src/memory/sessions.js';
import { MAX_PROPOSAL_CHARS, checkCadence, createGoalTool } from '../src/tools/goal.js';

const stateDir = FACTORY_TEST_STATE_DIR;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const SCOPE = 'telegram:test:123#main';

function newDb(): DatabaseSync {
  return new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-goals-')), 'g.db'));
}

function proposeIn(goals: GoalStore, title: string, cadence = '20 * * * *'): Goal {
  return goals.propose({
    scope: SCOPE,
    title,
    verbatim: `quiero que ${title}`,
    plan: [
      { text: 'paso uno', done: false },
      { text: 'paso dos', done: false },
    ],
    cadence,
  });
}

/** In-memory routines table with the Store shape the runner/tool need. */
function fakeRoutineStore() {
  const routines = new Map<string, Routine>();
  const key = (scope: string, name: string) => `${scope} ${name}`;
  return {
    routines,
    deleted: [] as string[],
    marked: [] as string[],
    saveRoutine(r: {
      scope: string;
      name: string;
      kind: 'schedule';
      prompt: string | null;
      schedule: string | null;
      enabled?: boolean;
    }) {
      const existing = routines.get(key(r.scope, r.name));
      const merged: Routine = {
        id: existing?.id ?? 'r1',
        scope: r.scope,
        name: r.name,
        kind: 'schedule',
        steps: null,
        prompt: r.prompt,
        schedule: r.schedule,
        enabled: r.enabled ?? true,
        createdAt: existing?.createdAt ?? 't0',
        updatedAt: 't1',
        lastRunAt: existing?.lastRunAt ?? null,
      };
      routines.set(key(r.scope, r.name), merged);
      return merged;
    },
    getRoutine(scope: string, name: string) {
      return routines.get(key(scope, name)) ?? null;
    },
    deleteRoutine(scope: string, name: string) {
      this.deleted.push(name);
      return routines.delete(key(scope, name));
    },
    markRoutineRun(scope: string, name: string) {
      this.marked.push(name);
      void scope;
    },
    listRoutines() {
      return [...routines.values()];
    },
  };
}

describe('goal store', () => {
  it('proposes, activates, pauses, resumes, blocks, completes', () => {
    const goals = new GoalStore({ db: newDb() });
    const g = proposeIn(goals, 'entradas concierto');
    expect(g.status).toBe('proposed');
    expect(() => goals.pause(g.id)).toThrow();
    goals.activate(g.id, 'ws-1');
    expect(goals.read(g.id)?.status).toBe('active');
    goals.pause(g.id);
    expect(goals.read(g.id)?.status).toBe('paused');
    goals.resume(g.id);
    expect(goals.read(g.id)?.status).toBe('active');
    goals.block(g.id, 'falta saber el día');
    expect(goals.read(g.id)?.blockedReason).toContain('día');
    goals.resume(g.id);
    expect(goals.read(g.id)?.blockedReason).toBeNull();
    goals.complete(g.id);
    expect(goals.read(g.id)?.status).toBe('done');
    expect(() => goals.cancel(g.id)).toThrow(/cumplido/);
  });

  it('caps active goals at 3 (global) and proposed at 5 per scope', () => {
    const goals = new GoalStore({ db: newDb() });
    for (let i = 0; i < MAX_ACTIVE_GOALS; i++) {
      const g = proposeIn(goals, `g${i}`);
      goals.activate(g.id, null);
    }
    const extra = proposeIn(goals, 'extra');
    expect(() => goals.activate(extra.id, null)).toThrow(/objetivos activos/);
    expect(MAX_ACTIVE_GOALS).toBe(3);
    for (let i = 0; i < MAX_PROPOSED_GOALS - 1; i++) proposeIn(goals, `p${i}`);
    expect(() => proposeIn(goals, 'de-mas')).toThrow(/propuestos/);
  });

  it('the active cap is global across scopes and resume re-checks it', () => {
    const goals = new GoalStore({ db: newDb() });
    const scopeB = 'telegram:test:999#main';
    const mk = (scope: string, title: string) =>
      goals.propose({
        scope,
        title,
        verbatim: 'v',
        plan: [{ text: 'p', done: false }],
        cadence: '20 * * * *',
      });
    const a = mk(SCOPE, 'A');
    const b = mk(SCOPE, 'B');
    const c = mk(scopeB, 'C'); // another chat entirely: still counts
    goals.activate(a.id, null);
    goals.activate(b.id, null);
    goals.activate(c.id, null);
    const d = mk(SCOPE, 'D');
    expect(() => goals.activate(d.id, null)).toThrow(/objetivos activos/);
    // Resume must re-check: pause A (2 active), activate D (3), resume A -> cap.
    goals.pause(a.id);
    goals.activate(d.id, null);
    expect(() => goals.resume(a.id)).toThrow(/objetivos activos/);
    expect(goals.read(a.id)?.status).toBe('paused');
    // Once a slot really frees, resume works again.
    goals.cancel(d.id);
    goals.resume(a.id);
    expect(goals.read(a.id)?.status).toBe('active');
  });

  it('attaches the workstream only after activation succeeded', () => {
    const goals = new GoalStore({ db: newDb() });
    const g = proposeIn(goals, 'proyección');
    goals.activate(g.id, null);
    expect(goals.read(g.id)?.workstreamId).toBeNull();
    goals.attachWorkstream(g.id, 'ws-9');
    expect(goals.read(g.id)?.workstreamId).toBe('ws-9');
  });

  it('counts ticks per local day and resets on a new day', () => {
    const goals = new GoalStore({ db: newDb() });
    const g = proposeIn(goals, 'largo');
    goals.activate(g.id, null);
    for (let i = 0; i < MAX_TICKS_PER_DAY; i++) goals.noteTick(g.id, 'progreso', '2026-10-12');
    let cur = goals.read(g.id);
    expect(cur?.ticksToday).toBe(MAX_TICKS_PER_DAY);
    expect(goals.tickAllowed(cur as Goal, '2026-10-12')).toBe(false);
    goals.noteTick(g.id, 'progreso', '2026-10-13');
    cur = goals.read(g.id);
    expect(cur?.ticksToday).toBe(1);
    expect(goals.tickAllowed(cur as Goal, '2026-10-13')).toBe(true);
  });
});

describe('goal notifier', () => {
  it('sends once per stable key and retries a failed send', async () => {
    const goals = new GoalStore({ db: newDb() });
    const g = proposeIn(goals, 'vigilante');
    const sent: string[] = [];
    let fail = true;
    const notifier = new GoalNotifier({
      db: newDb(),
      send: () => {
        if (fail) return Promise.resolve(null);
        sent.push('x');
        return Promise.resolve('msg-1');
      },
      resolveGoal: (id) => goals.read(id),
    });
    expect(await notifier.report(g, 'hito', 'salen a la venta')).toBe('pending');
    fail = false;
    expect(await notifier.report(g, 'hito', 'salen a la venta')).toBe('sent');
    expect(await notifier.report(g, 'hito', 'salen a la venta')).toBe('duplicate');
    expect(sent.length).toBe(1);
    expect(notifyKey('hito', 'Salen  a la venta')).toBe(notifyKey('hito', 'salen a la venta'));
  });

  it('notifyKey hashes the whole reason: long shared prefixes never collide', () => {
    const prefix = 'decisión sobre el presupuesto del viaje y las entradas '.padEnd(130, 'x');
    const k1 = notifyKey('decision', `${prefix} importe 20`);
    const k2 = notifyKey('decision', `${prefix} importe 2000`);
    expect(k1).not.toBe(k2);
    expect(notifyKey('hito', 'Salen  a la venta')).toBe(notifyKey('hito', 'salen a la venta'));
    expect(notifyKey('decision', `${prefix} importe 20`)).toBe(k1); // stable per content
  });

  it('routes a notification to the owning chat AND thread', () => {
    expect(goalNotifyTarget('telegram:acc:123#main')).toEqual({
      chatKey: 'telegram:acc:123',
      chatId: '123',
    });
    expect(goalNotifyTarget('telegram:acc:123#t456')).toEqual({
      chatKey: 'telegram:acc:123',
      chatId: '123',
      threadId: '456',
    });
    expect(goalNotifyTarget('telegram:acc:123#m789')).toEqual({
      chatKey: 'telegram:acc:123',
      chatId: '123',
      replyToMessageId: '789',
    });
    expect(goalNotifyTarget('sin-chat-id')).toBeNull();
    expect(splitGoalScope('telegram:acc:123#m789')).toEqual({
      chatKey: 'telegram:acc:123',
      thread: 'm789',
    });
    expect(splitGoalScope('telegram:acc:123')).toEqual({
      chatKey: 'telegram:acc:123',
      thread: 'main',
    });
  });

  it('stores the sent id and resolves the owning scope back from it', async () => {
    const goals = new GoalStore({ db: newDb() });
    const g = proposeIn(goals, 'enrutado');
    const notifier = new GoalNotifier({
      db: newDb(),
      send: () => Promise.resolve('777'),
      resolveGoal: (id) => goals.read(id),
    });
    expect(await notifier.report(g, 'decision', '¿20 o 2000?')).toBe('sent');
    expect(notifier.scopeBySentId('777')).toBe(g.scope);
    expect(notifier.scopeBySentId('desconocido')).toBeNull();
  });

  it('flushAll retries every goal\u2019s pending notes and cleans up after deleted goals', async () => {
    const goals = new GoalStore({ db: newDb() });
    const g1 = proposeIn(goals, 'uno');
    const g2 = proposeIn(goals, 'dos');
    let up = false;
    const delivered: string[] = [];
    const notifier = new GoalNotifier({
      db: newDb(),
      send: (goal, text) => {
        if (!up) return Promise.resolve(null);
        delivered.push(`${goal.title}:${text.slice(0, 12)}`);
        return Promise.resolve('m-x');
      },
      resolveGoal: (id) => goals.read(id),
    });
    await notifier.report(g1, 'decision', '¿A o B?');
    await notifier.report(g2, 'hecho', 'terminado');
    // A pending note for a goal that no longer exists.
    await notifier.report({ ...g1, id: 'gone', title: 'fantasma' }, 'hito', 'nada');
    expect(notifier.hasPending(g1.id)).toBe(true);
    expect(notifier.hasPending(g2.id)).toBe(true);
    await notifier.flushAll(); // transport down: nothing moves, nothing is lost
    expect(delivered).toHaveLength(0);
    expect(notifier.hasPending(g1.id)).toBe(true);
    up = true;
    await notifier.flushAll();
    expect(delivered).toHaveLength(2);
    expect(notifier.hasPending(g1.id)).toBe(false);
    expect(notifier.hasPending(g2.id)).toBe(false);
    // The deleted goal's rows were dropped, and flushAll stays idempotent.
    await notifier.flushAll();
    expect(delivered).toHaveLength(2);
  });

  it('formats one Spanish piece per kind', () => {
    expect(formatGoalMessage('hito', { title: 'T' }, 'paso listo')).toContain('🎯 T: paso listo');
    expect(formatGoalMessage('bloqueo', { title: 'T' }, 'falta X')).toContain('bloqueado');
    expect(formatGoalMessage('decision', { title: 'T' }, '¿cuál?')).toContain('decisión');
    expect(formatGoalMessage('hecho', { title: 'T' }, 'fin')).toContain('cumplido');
  });
});

describe('goal outcome parsing', () => {
  it('reads the tags, with and without accents', () => {
    expect(parseOutcome('[progreso] nada que contar').kind).toBe('progreso');
    expect(parseOutcome('[hito] salió la convocatoria').kind).toBe('hito');
    expect(parseOutcome('[decisión] ¿A o B?').kind).toBe('decision');
    expect(parseOutcome('[HECHO] todo listo').kind).toBe('hecho');
    expect(parseOutcome('sin etiqueta ninguna').kind).toBe('desconocido');
    expect(parseOutcome('').kind).toBe('desconocido');
  });
});

describe('goal runner ticks', () => {
  function setup(execResults: Array<{ text: string; error: string | null }>) {
    const goals = new GoalStore({ db: newDb() });
    const routines = fakeRoutineStore();
    const sent: string[] = [];
    const notifier = new GoalNotifier({
      db: newDb(),
      send: (_g, text) => {
        sent.push(text);
        return Promise.resolve('m-1');
      },
      resolveGoal: (id) => goals.read(id),
    });
    let syncs = 0;
    const done: string[] = [];
    let calls = 0;
    const runner = new GoalRunner({
      goals,
      notifier,
      store: routines,
      sync: () => {
        syncs++;
      },
      onDone: (g) => done.push(g.id),
      dayKey: () => '2026-10-12',
      execute: () =>
        Promise.resolve(
          execResults[Math.min(calls++, execResults.length - 1)] ?? { text: '', error: 'sin más' },
        ),
    });
    return { goals, routines, sent, runner, getSyncs: () => syncs, done };
  }

  it('[progreso] stays silent; [hito] notifies once; [hecho] completes and self-cleans', async () => {
    const { goals, routines, sent, runner, getSyncs, done } = setup([
      { text: '[progreso] miré y no hay nada', error: null },
      { text: '[hito] salió la convocatoria', error: null },
      { text: '[hecho] dossier entregado', error: null },
    ]);
    const g = proposeIn(goals, 'dossier');
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: SCOPE,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });

    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(0);
    expect(goals.read(g.id)?.lastOutcome).toBe('progreso');

    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('salió la convocatoria');

    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('cumplido');
    expect(goals.read(g.id)?.status).toBe('done');
    expect(routines.deleted).toContain(goalRoutineName(g.id));
    expect(getSyncs()).toBeGreaterThan(0);
    expect(done).toEqual([g.id]);

    // A late firing after done: self-clean, no crash, no new message.
    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(2);
  });

  it('[bloqueo] blocks and waits; a blocked goal does not tick until resumed', async () => {
    const { goals, routines, sent, runner } = setup([
      { text: '[bloqueo] no sé qué día prefiere', error: null },
      { text: '[progreso] sigo', error: null },
    ]);
    const g = proposeIn(goals, 'cita');
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: SCOPE,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });

    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('bloqueado');
    expect(goals.read(g.id)?.status).toBe('blocked');

    const ticksBefore = goals.read(g.id)?.ticksToday ?? 0;
    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(goals.read(g.id)?.ticksToday).toBe(ticksBefore);
    expect(sent.length).toBe(1);

    goals.resume(g.id);
    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(goals.read(g.id)?.ticksToday).toBe(ticksBefore + 1);
  });

  it('an execution error notifies once per distinct error and the goal stays active', async () => {
    const { goals, routines, sent, runner } = setup([
      { text: '', error: 'provider caído' },
      { text: '', error: 'provider caído' },
    ]);
    const g = proposeIn(goals, 'inestable');
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: SCOPE,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });

    await runner.tickByRoutineName(goalRoutineName(g.id));
    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('provider caído');
    expect(goals.read(g.id)?.status).toBe('active');
  });

  it('a missing/unknown outcome tag is notified (escala si dudas), not swallowed', async () => {
    const { goals, routines, sent, runner } = setup([{ text: 'hice cosas varias', error: null }]);
    const g = proposeIn(goals, 'difuso');
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: SCOPE,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });
    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain('hice cosas varias');
  });

  it('skips silently once the day budget (12) is spent', async () => {
    const { goals, routines, sent, runner } = setup([{ text: '[progreso] ok', error: null }]);
    const g = proposeIn(goals, 'incansable');
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: SCOPE,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });
    for (let i = 0; i < MAX_TICKS_PER_DAY + 2; i++) {
      await runner.tickByRoutineName(goalRoutineName(g.id));
    }
    expect(goals.read(g.id)?.ticksToday).toBe(MAX_TICKS_PER_DAY);
    expect(sent.length).toBe(0);
  });

  it('recognizes its own routines only', () => {
    expect(isGoalRoutine({ name: goalRoutineName('abc') })).toBe(true);
    expect(isGoalRoutine({ name: 'recordatorio: agua' })).toBe(false);
  });

  it('the tick prompt carries the plan, the literal objective and the tag contract', () => {
    const goals = new GoalStore({ db: newDb() });
    const g = proposeIn(goals, 'prompt');
    const prompt = buildTickPrompt(g);
    expect(prompt).toContain('quiero que prompt');
    expect(prompt).toContain('[ ] paso uno');
    expect(prompt).toContain('[hito]');
    expect(prompt).toContain('[decision]');
  });
});

describe('goal runner delivery vs eligibility', () => {
  function setupFailingTransport(execResult: { text: string; error: string | null }) {
    const goals = new GoalStore({ db: newDb() });
    const routines = fakeRoutineStore();
    const sent: string[] = [];
    let transportUp = false;
    const notifier = new GoalNotifier({
      db: newDb(),
      send: (_g, text) => {
        if (!transportUp) return Promise.resolve(null);
        sent.push(text);
        return Promise.resolve('m-fail-1');
      },
      resolveGoal: (id) => goals.read(id),
    });
    let execCalls = 0;
    let syncs = 0;
    const done: string[] = [];
    const runner = new GoalRunner({
      goals,
      notifier,
      store: routines,
      sync: () => {
        syncs++;
      },
      onDone: (g) => done.push(g.id),
      dayKey: () => '2026-10-12',
      execute: () => {
        execCalls++;
        return Promise.resolve(execResult);
      },
    });
    const g = proposeIn(goals, 'presupuesto');
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: SCOPE,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });
    return {
      goals,
      routines,
      sent,
      notifier,
      runner,
      g,
      done,
      setTransportUp: (v: boolean) => {
        transportUp = v;
      },
      getExecCalls: () => execCalls,
      getSyncs: () => syncs,
    };
  }

  it('flushes a pending decision while blocked, without running work', async () => {
    const { goals, sent, notifier, runner, g, setTransportUp, getExecCalls } =
      setupFailingTransport({ text: '[decision] ¿20 o 2000?', error: null });
    const name = goalRoutineName(g.id);
    // Tick 1: decision, transport down -> pending notification, goal blocked.
    await runner.tickByRoutineName(name);
    expect(goals.read(g.id)?.status).toBe('blocked');
    expect(sent).toHaveLength(0);
    expect(notifier.hasPending(g.id)).toBe(true);
    // Tick 2 while blocked: delivery retried, no work runs.
    await runner.tickByRoutineName(name);
    expect(getExecCalls()).toBe(1);
    // Tick 3 with the transport back: the question finally reaches Nico.
    setTransportUp(true);
    await runner.tickByRoutineName(name);
    expect(getExecCalls()).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('¿20 o 2000?');
    expect(notifier.hasPending(g.id)).toBe(false);
  });

  it('keeps the routine after [hecho] until the closing note is delivered', async () => {
    const { goals, routines, sent, runner, g, done, setTransportUp, getExecCalls } =
      setupFailingTransport({ text: '[hecho] dossier entregado', error: null });
    const name = goalRoutineName(g.id);
    await runner.tickByRoutineName(name);
    expect(goals.read(g.id)?.status).toBe('done');
    expect(done).toEqual([g.id]);
    expect(sent).toHaveLength(0);
    // Undelivered closing note: the routine stays alive for the flush.
    expect(routines.getRoutine(SCOPE, name)).not.toBeNull();
    setTransportUp(true);
    await runner.tickByRoutineName(name);
    expect(getExecCalls()).toBe(1); // done goals never execute again
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('dossier entregado');
    // Delivered: the routine cleans itself up.
    expect(routines.getRoutine(SCOPE, name)).toBeNull();
  });

  it('still flushes pending notifications when the daily budget is exhausted', async () => {
    const { goals, sent, notifier, runner, g, setTransportUp, getExecCalls } =
      setupFailingTransport({ text: '[progreso] nada', error: null });
    const name = goalRoutineName(g.id);
    // Plant an undelivered notification and exhaust the day.
    await notifier.report(g, 'hito', 'salió la convocatoria');
    expect(notifier.hasPending(g.id)).toBe(true);
    for (let i = 0; i < MAX_TICKS_PER_DAY; i++) goals.noteTick(g.id, 'progreso', '2026-10-12');
    setTransportUp(true);
    await runner.tickByRoutineName(name);
    expect(getExecCalls()).toBe(0); // budget exhausted: no work
    expect(sent).toHaveLength(1); // but the pending milestone still lands
    expect(sent[0]).toContain('salió la convocatoria');
  });

  it('executes and notifies on the owning non-main thread, not #main', async () => {
    const scopeM = 'telegram:test:123#m456';
    const goals = new GoalStore({ db: newDb() });
    const routines = fakeRoutineStore();
    const notifiedScopes: string[] = [];
    const notifier = new GoalNotifier({
      db: newDb(),
      send: (goal) => {
        const t = goalNotifyTarget(goal.scope);
        expect(t?.chatId).toBe('123');
        expect(t?.replyToMessageId).toBe('456');
        notifiedScopes.push(goal.scope);
        return Promise.resolve('mm-1');
      },
      resolveGoal: (id) => goals.read(id),
    });
    const executedScopes: string[] = [];
    const runner = new GoalRunner({
      goals,
      notifier,
      store: routines,
      sync: () => {},
      dayKey: () => '2026-10-12',
      execute: (goal) => {
        executedScopes.push(goal.scope);
        return Promise.resolve({ text: '[hito] paso listo', error: null });
      },
    });
    const g = goals.propose({
      scope: scopeM,
      title: 'hilo',
      verbatim: 'v',
      plan: [{ text: 'p', done: false }],
      cadence: '20 * * * *',
    });
    goals.activate(g.id, null);
    routines.saveRoutine({
      scope: scopeM,
      name: goalRoutineName(g.id),
      kind: 'schedule',
      prompt: 'x',
      schedule: '20 * * * *',
    });
    await runner.tickByRoutineName(goalRoutineName(g.id));
    expect(executedScopes).toEqual([scopeM]);
    expect(notifiedScopes).toEqual([scopeM]);
    // And the split the cli wiring relies on keeps the thread name intact.
    expect(splitGoalScope(scopeM).thread).toBe('m456');
  });
});

describe('objetivo tool', () => {
  function setupTool() {
    const goals = new GoalStore({ db: newDb() });
    const routines = fakeRoutineStore();
    const ws = {
      created: [] as string[],
      forgotten: [] as string[],
      create: (_scope: string, title: string) => {
        ws.created.push(title);
        return `ws-${ws.created.length}`;
      },
      update: () => {},
      forget: (id: string) => {
        ws.forgotten.push(id);
      },
    };
    let syncs = 0;
    let humanReplied = true;
    const tool = createGoalTool({
      goals,
      scopeOf: () => SCOPE,
      store: routines,
      sync: () => {
        syncs++;
      },
      workstreams: ws,
      humanRepliedAfter: () => humanReplied,
    });
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => c.text ?? '').join('\n');
    return {
      goals,
      routines,
      ws,
      run,
      text,
      getSyncs: () => syncs,
      setHumanReplied: (v: boolean) => {
        humanReplied = v;
      },
    };
  }

  it('proponer validates cadence and shows the plan in one Spanish piece', async () => {
    const { run, text } = setupTool();
    expect(
      text(
        await run({
          action: 'proponer',
          titulo: 'x',
          objetivo: 'y',
          pasos: ['a'],
          cadencia: '* * * * *',
        }),
      ),
    ).toContain('una vez por hora');
    expect(
      text(
        await run({
          action: 'proponer',
          titulo: 'x',
          objetivo: 'y',
          pasos: [],
          cadencia: '20 * * * *',
        }),
      ),
    ).toContain('al menos un paso');
    const ok = text(
      await run({
        action: 'proponer',
        titulo: 'Dossier',
        objetivo: 'quiero el dossier',
        pasos: ['buscar', 'redactar'],
        cadencia: '20 * * * *',
      }),
    );
    expect(ok).toContain('🎯 Objetivo propuesto: "Dossier"');
    expect(ok).toContain('1. buscar');
    expect(ok).toContain('responde "sí"');
    expect(ok.length).toBeLessThanOrEqual(MAX_PROPOSAL_CHARS);
    expect(checkCadence('0 8 * * *')).toBeNull();
  });

  it('rejects a cadence with zero future runs (30 de febrero)', () => {
    expect(checkCadence('0 0 30 2 *')).toContain('ninguna ejecución futura');
    expect(checkCadence('0 0 31 4 *')).toContain('ninguna ejecución futura');
    expect(checkCadence('0 9 * * 1')).toBeNull();
  });

  it('proponer refuses a plan that would not fit in one Telegram message', async () => {
    const { goals, run, text } = setupTool();
    const pasos = Array.from({ length: 20 }, (_, i) => `paso ${i} ${'x'.repeat(190)}`);
    const r = text(
      await run({
        action: 'proponer',
        titulo: 'Gordo',
        objetivo: 'y'.repeat(900),
        pasos,
        cadencia: '20 * * * *',
      }),
    );
    expect(r).toContain('no cabe en un solo mensaje');
    expect(r).toContain('Nada quedó guardado');
    expect(goals.list(SCOPE)).toHaveLength(0); // nothing stored on rejection
  });

  it('proponer rejects over-limit input honestly and stores nothing', async () => {
    const { goals, run, text } = setupTool();
    const r1 = text(
      await run({
        action: 'proponer',
        titulo: 't',
        objetivo: `${'x'.repeat(1000)} NO COMPRAR NI ENVIAR`,
        pasos: ['a'],
        cadencia: '20 * * * *',
      }),
    );
    expect(r1).toContain('no puede pasar de 1000 caracteres');
    const r2 = text(
      await run({
        action: 'proponer',
        titulo: 't',
        objetivo: 'o',
        pasos: ['a', `${'p'.repeat(200)} preguntar antes`],
        cadencia: '20 * * * *',
      }),
    );
    expect(r2).toContain('El paso 2 no puede pasar de 200 caracteres');
    const r3 = text(
      await run({
        action: 'proponer',
        titulo: 't',
        objetivo: 'o',
        pasos: Array.from({ length: 21 }, (_, i) => `paso ${i}`),
        cadencia: '20 * * * *',
      }),
    );
    expect(r3).toContain('más de 20 pasos');
    const r4 = text(
      await run({
        action: 'proponer',
        titulo: 'x'.repeat(121),
        objetivo: 'o',
        pasos: ['a'],
        cadencia: '20 * * * *',
      }),
    );
    expect(r4).toContain('no puede pasar de 120 caracteres');
    expect(goals.list(SCOPE)).toHaveLength(0); // nothing stored, ever
  });

  it('reanudar evidence window starts at blockedAt, not at a later avance', async () => {
    const goals = new GoalStore({ db: newDb() });
    const routines = fakeRoutineStore();
    let capturedSince = '';
    const tool = createGoalTool({
      goals,
      scopeOf: () => SCOPE,
      store: routines,
      sync: () => {},
      workstreams: { create: () => 'w', update: () => {}, forget: () => {} },
      humanRepliedAfter: (_scope, sinceIso) => {
        capturedSince = sinceIso;
        return true;
      },
    });
    const g = goals.propose({
      scope: SCOPE,
      title: 'ventana',
      verbatim: 'v',
      plan: [{ text: 'p', done: false }],
      cadence: '20 * * * *',
    });
    goals.activate(g.id, null);
    goals.block(g.id, 'Decisión pendiente: ¿A o B?');
    const blockedAt = goals.read(g.id)?.blockedAt ?? '';
    expect(blockedAt).not.toBe('');
    await new Promise((r) => setTimeout(r, 5));
    await tool.execute('c', { action: 'avance', id: g.id, paso: 1 } as never); // bumps updatedAt
    expect(goals.read(g.id)?.updatedAt).not.toBe(blockedAt);
    await tool.execute('c', { action: 'reanudar', id: g.id } as never);
    expect(capturedSince).toBe(blockedAt); // the window starts at the BLOCK
    expect(goals.read(g.id)?.blockedAt).toBeNull();
  });

  it('activar rejected by the cap leaves no orphaned workstream', async () => {
    const { goals, ws, run, text } = setupTool();
    for (const t of ['g1', 'g2', 'g3']) {
      const p = text(
        await run({
          action: 'proponer',
          titulo: t,
          objetivo: 'x',
          pasos: ['a'],
          cadencia: '20 * * * *',
        }),
      );
      const id = /\(id: ([^)]+)\)/.exec(p)?.[1] ?? '';
      await run({ action: 'activar', id });
    }
    expect(ws.created).toHaveLength(3);
    const p4 = text(
      await run({
        action: 'proponer',
        titulo: 'g4',
        objetivo: 'x',
        pasos: ['a'],
        cadencia: '20 * * * *',
      }),
    );
    const id4 = /\(id: ([^)]+)\)/.exec(p4)?.[1] ?? '';
    await expect(run({ action: 'activar', id: id4 })).rejects.toThrow(/objetivos activos/);
    expect(ws.created).toHaveLength(3); // no orphan
    expect(goals.read(id4)?.status).toBe('proposed');
    expect(goals.read(id4)?.workstreamId).toBeNull();
  });

  it('reanudar a blocked goal requires evidence Nico answered; paused needs none', async () => {
    const { goals, run, text, setHumanReplied } = setupTool();
    const proposed = text(
      await run({
        action: 'proponer',
        titulo: 'Decisiones',
        objetivo: 'x',
        pasos: ['a'],
        cadencia: '20 * * * *',
      }),
    );
    const id = /\(id: ([^)]+)\)/.exec(proposed)?.[1] ?? '';
    await run({ action: 'activar', id });
    goals.block(id, 'Decisión pendiente: ¿20 o 2000?');
    // No human reply since the block: resume refuses, goal stays blocked.
    setHumanReplied(false);
    const denied = text(await run({ action: 'reanudar', id }));
    expect(denied).toContain('esperando tu respuesta');
    expect(goals.read(id)?.status).toBe('blocked');
    // Evidence of his answer: resume goes through.
    setHumanReplied(true);
    const ok = text(await run({ action: 'reanudar', id }));
    expect(ok).toContain('reanudado');
    expect(goals.read(id)?.status).toBe('active');
    // And a plain pause/resume cycle never asks for evidence.
    await run({ action: 'pausar', id });
    setHumanReplied(false);
    const ok2 = text(await run({ action: 'reanudar', id }));
    expect(ok2).toContain('reanudado');
    expect(goals.read(id)?.status).toBe('active');
  });

  it('activar starts the routine and the workstream; cancelar removes both', async () => {
    const { goals, routines, ws, run, text, getSyncs } = setupTool();
    const proposed = text(
      await run({
        action: 'proponer',
        titulo: 'Viaje',
        objetivo: 'prepárame el viaje',
        pasos: ['vuelos'],
        cadencia: '30 9 * * *',
      }),
    );
    const id = /\(id: ([^)]+)\)/.exec(proposed)?.[1] ?? '';

    const act = text(await run({ action: 'activar', id }));
    expect(act).toContain('activado');
    expect(goals.read(id)?.status).toBe('active');
    expect(routines.getRoutine(SCOPE, goalRoutineName(id))?.enabled).toBe(true);
    expect(ws.created).toEqual(['Viaje']);
    expect(getSyncs()).toBeGreaterThan(0);

    const c = text(await run({ action: 'cancelar', id }));
    expect(c).toContain('cancelado');
    expect(routines.getRoutine(SCOPE, goalRoutineName(id))).toBeNull();
    expect(ws.forgotten.length).toBe(1);
    expect(goals.read(id)?.status).toBe('cancelled');
  });

  it('pausar keeps the routine but disabled; reanudar re-enables it', async () => {
    const { goals, routines, run, text } = setupTool();
    const proposed = text(
      await run({
        action: 'proponer',
        titulo: 'Pausable',
        objetivo: 'x',
        pasos: ['a'],
        cadencia: '30 9 * * *',
      }),
    );
    const id = /\(id: ([^)]+)\)/.exec(proposed)?.[1] ?? '';
    await run({ action: 'activar', id });
    await run({ action: 'pausar', id });
    expect(goals.read(id)?.status).toBe('paused');
    expect(routines.getRoutine(SCOPE, goalRoutineName(id))?.enabled).toBe(false);
    await run({ action: 'reanudar', id });
    expect(goals.read(id)?.status).toBe('active');
    expect(routines.getRoutine(SCOPE, goalRoutineName(id))?.enabled).toBe(true);
  });

  it('avance marks plan steps and estado reads them back', async () => {
    const { goals, run, text } = setupTool();
    const proposed = text(
      await run({
        action: 'proponer',
        titulo: 'Pasos',
        objetivo: 'x',
        pasos: ['uno', 'dos'],
        cadencia: '30 9 * * *',
      }),
    );
    const id = /\(id: ([^)]+)\)/.exec(proposed)?.[1] ?? '';
    await run({ action: 'avance', id, paso: 1, nota: 'hecho hoy' });
    expect(goals.read(id)?.plan[0]?.done).toBe(true);
    const st = text(await run({ action: 'estado', id }));
    expect(st).toContain('[x] uno');
    expect(st).toContain('[ ] dos');
  });

  it('refuses to touch a goal owned by another chat', async () => {
    const goals = new GoalStore({ db: newDb() });
    const mk = (scope: string) =>
      createGoalTool({
        goals,
        scopeOf: () => scope,
        store: fakeRoutineStore(),
        sync: () => {},
        workstreams: { create: () => 'w', update: () => {}, forget: () => {} },
        humanRepliedAfter: () => true,
      });
    const owner = mk(SCOPE);
    const intruder = mk('telegram:test:999#main');
    const proposed = await owner.execute('c', {
      action: 'proponer',
      titulo: 'Mío',
      objetivo: 'x',
      pasos: ['a'],
      cadencia: '30 9 * * *',
    } as never);
    const body = proposed.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n');
    const id = /\(id: ([^)]+)\)/.exec(body)?.[1] ?? '';
    expect(id).not.toBe('');
    const r = await intruder.execute('c', { action: 'cancelar', id } as never);
    expect(r.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')).toContain(
      'otro chat',
    );
    expect(goals.read(id)?.status).toBe('proposed');
  });
});

describe('sessions: human-turn evidence', () => {
  it('hasHumanTurnSince goes by provenance, never by title', () => {
    const sessions = new SessionStore({ db: newDb() });
    const t0 = Date.now() - 1000;
    expect(sessions.hasHumanTurnSince(SCOPE, t0)).toBe(false);
    sessions.begin(SCOPE, '[objetivo] presupuesto', 'goal-tick'); // the machine's own tick
    expect(sessions.hasHumanTurnSince(SCOPE, t0)).toBe(false);
    sessions.begin(SCOPE, 'sí, adelante con las de 2000'); // Nico's answer
    expect(sessions.hasHumanTurnSince(SCOPE, t0)).toBe(true);
    expect(sessions.hasHumanTurnSince(SCOPE, Date.now() + 60_000)).toBe(false);
    expect(sessions.hasHumanTurnSince('telegram:test:otro#main', t0)).toBe(false);
  });

  it('a human message titled "[objetivo] ..." still counts as human', () => {
    const sessions = new SessionStore({ db: newDb() });
    const t0 = Date.now() - 1000;
    sessions.begin(SCOPE, '[objetivo] elige la opción barata'); // a person, free title
    expect(sessions.hasHumanTurnSince(SCOPE, t0)).toBe(true);
  });
});

describe('Gate: objetivo activar always asks', () => {
  const activateCall = { tool: 'objetivo', args: { action: 'activar', id: 'x' }, actor: 'test' };

  it('asks even with an always scope on objetivo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-goal-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s', 'objetivo', 'always');
    const d = await gate.check('s', activateCall);
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks again for a second identical activation (no memo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-goal-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s', activateCall);
    await gate.check('s', activateCall);
    expect(asked).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks under fullControl too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-goal-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s', activateCall);
    expect(asked).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks with allowUntilPayment even when the call is labelled browse or fill', async () => {
    for (const stage of ['browse', 'fill'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'pa-goal-gate-'));
      let asked = 0;
      const gate = new Gate({
        dbPath: join(dir, 'g.db'),
        grantWindowMs: 0,
        allowUntilPayment: true,
        approver: () => {
          asked++;
          return true;
        },
      });
      const d = await gate.check('s', { ...activateCall, stage });
      expect(d.verdict).toBe('allow'); // the human said yes - through the ask
      expect(asked).toBe(1);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('asks when a stage resolver labels the activation browse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-goal-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      allowUntilPayment: true,
      stageOf: () => 'browse',
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s', activateCall);
    expect(asked).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still lets an ordinary preflight call through without asking', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-goal-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      allowUntilPayment: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check('s', {
      tool: 'browser',
      args: { action: 'navigate', url: 'https://example.com' },
      actor: 'test',
      stage: 'browse',
    });
    expect(d.verdict).toBe('allow');
    expect(asked).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
