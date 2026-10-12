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
import { GoalNotifier, formatGoalMessage, notifyKey } from '../src/goals/notify.js';
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
} from '../src/goals/store.js';
import { checkCadence, createGoalTool } from '../src/tools/goal.js';

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

  it('caps active goals at 3 and proposed at 5 per scope', () => {
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
        if (fail) return Promise.resolve(false);
        sent.push('x');
        return Promise.resolve(true);
      },
    });
    expect(await notifier.report(g, 'hito', 'salen a la venta')).toBe('pending');
    fail = false;
    expect(await notifier.report(g, 'hito', 'salen a la venta')).toBe('sent');
    expect(await notifier.report(g, 'hito', 'salen a la venta')).toBe('duplicate');
    expect(sent.length).toBe(1);
    expect(notifyKey('hito', 'Salen  a la venta')).toBe(notifyKey('hito', 'salen a la venta'));
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
        return Promise.resolve(true);
      },
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
    const tool = createGoalTool({
      goals,
      scopeOf: () => SCOPE,
      store: routines,
      sync: () => {
        syncs++;
      },
      workstreams: ws,
    });
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => c.text ?? '').join('\n');
    return { goals, routines, ws, run, text, getSyncs: () => syncs };
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
    expect(checkCadence('0 8 * * *')).toBeNull();
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
});
