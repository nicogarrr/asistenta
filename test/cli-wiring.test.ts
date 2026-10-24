/**
 * Wiring tests for the conversation-to-memory path of `src/cli.ts`: what a turn
 * records as an instinct, what becomes a follow-up, what goes into the prompt as
 * a workstream, and how a Spanish schedule becomes a routine.
 *
 * Everything here is either a pure helper or a store on a temp database. The
 * daemon itself needs a Telegram token and a real desktop, so the closures
 * inside `serveCommand` are exercised through the exact helpers they call.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildContextNote,
  capturePageIfOpen,
  followupFromMessage,
  formatNextRun,
  formatSessionHits,
  instinctsFromTurn,
  nextRunLabel,
  routineNameFromPrompt,
} from '../src/cli.js';
import { parseNatural } from '../src/cron/scheduler.js';
import { Store } from '../src/db.js';
import { DecisionLedger } from '../src/memory/decisions.js';
import { WorkstreamStore } from '../src/memory/workstreams.js';
import { MemoryStore } from '../src/memory.js';
import { SkillStore } from '../src/skills/store.js';
import { createDecisionTool } from '../src/tools/decision.js';

const DAY_MS = 86_400_000;
const SCOPE = 'telegram:main:42#main';

let dir = '';
let store: Store;
let memory: MemoryStore;
let workDb: DatabaseSync;
let workstreams: WorkstreamStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-cli-'));
  store = new Store(join(dir, 'db.sqlite'));
  memory = new MemoryStore(join(dir, 'memory'));
  workDb = new DatabaseSync(':memory:');
  workstreams = new WorkstreamStore({ db: workDb });
});

afterEach(() => {
  store.close();
  workDb.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('instinctsFromTurn', () => {
  it('records a stated preference in the words the user used', () => {
    expect(instinctsFromTurn('prefiero el café solo', [])).toEqual([
      { pattern: 'prefiero el café solo', category: 'pref' },
    ]);
  });

  it('sees the four preference triggers and nothing else', () => {
    for (const text of ['me gustan los gatos', 'siempre llegas tarde', 'nunca me avises']) {
      expect(instinctsFromTurn(text, []), text).toHaveLength(1);
    }
    // Ordinary requests are not preferences, however often they repeat.
    expect(instinctsFromTurn('haz la compra por favor', [])).toEqual([]);
  });

  it('records a tool sequence only from two calls in a row', () => {
    expect(instinctsFromTurn('haz la compra', ['browser'])).toEqual([]);
    expect(instinctsFromTurn('haz la compra', ['browser', 'shell', 'done'])).toEqual([
      { pattern: 'browser -> shell -> done', category: 'seq' },
    ]);
  });

  it('keeps both signals when a turn has a preference and a sequence', () => {
    const out = instinctsFromTurn('prefiero que lo hagas así', ['shell', 'done']);
    expect(out.map((o) => o.category)).toEqual(['pref', 'seq']);
  });
});

/**
 * The follow-up gate is the difference between a reminder system and a nagging
 * one: only a durable statement that carries a date becomes a note.
 */
describe('followupFromMessage', () => {
  // Tuesday noon, so "el viernes" has a determinate distance whatever the
  // machine's timezone is.
  const TUESDAY_NOON = new Date(2026, 9, 6, 12, 0, 0).getTime();

  it('tracks a promise with a weekday on that weekday', () => {
    const hit = followupFromMessage('voy a llamar al banco el viernes', TUESDAY_NOON);
    expect(hit).not.toBeNull();
    expect(hit?.subject).toContain('banco');
    expect(hit?.dueAt).toBe(TUESDAY_NOON + 3 * DAY_MS);
  });

  it('tracks "mañana" for tomorrow', () => {
    const hit = followupFromMessage('he decidido que empiezo el curso mañana', TUESDAY_NOON);
    expect(hit?.dueAt).toBe(TUESDAY_NOON + DAY_MS);
  });

  it('falls back to a week when the date cannot be placed', () => {
    const hit = followupFromMessage('voy a pagar el seguro antes del 12', TUESDAY_NOON);
    expect(hit?.dueAt).toBe(TUESDAY_NOON + 7 * DAY_MS);
  });

  it('ignores a durable statement with no date: that is memory, not a follow-up', () => {
    expect(followupFromMessage('prefiero el té verde por la tarde', TUESDAY_NOON)).toBeNull();
  });

  it('ignores a date without a promise behind it', () => {
    expect(followupFromMessage('mañana te mando el informe del proyecto', TUESDAY_NOON)).toBeNull();
  });

  it('does not read "por la mañana" as a due date', () => {
    expect(followupFromMessage('prefiero las reuniones por la mañana', TUESDAY_NOON)).toBeNull();
  });
});

describe('formatSessionHits', () => {
  const hits = [
    {
      sessionId: 's1',
      title: 'compra semanal',
      summary: 'fuimos al mercado y compramos pescado',
      snippet: '…mercado y compramos…',
      at: Date.UTC(2026, 9, 1),
    },
  ];

  it('lists title, day and snippet in Spanish', () => {
    const out = formatSessionHits(hits);
    expect(out).toContain('compra semanal (2026-10-01):');
    expect(out).toContain('mercado');
    expect(out).toContain('Esto es lo que encontré (1)');
  });

  it('says what it looked for when nothing matched', () => {
    expect(formatSessionHits([], 'renfe')).toContain('No he encontrado nada sobre "renfe"');
    expect(formatSessionHits([])).toContain('No he encontrado nada');
  });
});

/**
 * `/routine cada mañana a las 8 resumen del día` is the whole reason `parseNatural`
 * is wired into the command: the user never writes a cron expression, so the
 * words have to become one and the task has to keep a name they can type back.
 */
describe('routine creation from Spanish', () => {
  it('turns the words into a cron schedule and a repeatable name', () => {
    const parsed = parseNatural('cada mañana a las 8 resumen del día');
    expect(parsed?.schedule).toBe('0 8 * * *');
    expect(routineNameFromPrompt(parsed?.prompt ?? '')).toBe('resumen');
  });

  it('names the routine after what is left once the schedule words are gone', () => {
    expect(routineNameFromPrompt('cada viernes a las 18 informe semanal')).toBe('informe-semanal');
    // Nothing task-shaped in the words: a name is still needed, since the store
    // keys routines by (scope, name).
    expect(routineNameFromPrompt('cada 5 minutos')).toBe('rutina');
  });

  it('leaves text without a schedule alone', () => {
    expect(parseNatural('haz la compra cuando puedas')).toBeNull();
  });
});

describe('next run labels', () => {
  const now = new Date(2026, 9, 6, 12, 0, 0).getTime();

  it('describes the distance in Spanish units', () => {
    expect(formatNextRun(now + 30 * 60_000, now)).toContain('(en 30 min)');
    expect(formatNextRun(now + 3_600_000, now)).toContain('(en 1 h)');
    expect(formatNextRun(now + 2 * DAY_MS, now)).toContain('(en 2 d)');
    expect(formatNextRun(now, now)).toContain('(ya)');
  });

  it('prefers the live scheduler when it has an answer', () => {
    const live = new Date(now + 3_600_000).toISOString();
    expect(nextRunLabel('0 8 * * *', live, now)).toContain('(en 1 h)');
  });

  it('falls back to the cron expression and to "no idea" when there is none', () => {
    expect(nextRunLabel('0 8 * * *', null, now)).toMatch(/^\d{4}-\d{2}-\d{2} .* UTC[+-]/);
    expect(nextRunLabel(null, null, now)).toBe('sin próxima ejecución');
  });
});

describe('buildContextNote skills', () => {
  it('adds the skills index only when there are skills, before the date note', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-skills-'));
    const skills = new SkillStore({ dir });
    const empty = buildContextNote(
      { key: SCOPE, name: 'main' },
      store,
      memory,
      undefined,
      undefined,
      skills,
    );
    expect(empty).not.toContain('<skills>');
    skills.save({
      name: 'Pedir taxi',
      description: 'taxi',
      category: 'general',
      whenToUse: 'cuando pida un taxi',
      steps: ['abre la app'],
    });
    const note = buildContextNote(
      { key: SCOPE, name: 'main' },
      store,
      memory,
      undefined,
      undefined,
      skills,
    );
    expect(note).toContain('- pedir-taxi: cuando pida un taxi');
    expect(note).not.toContain('abre la app');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildContextNote workstreams', () => {
  it('keeps workstreams out of the prompt while nothing is open', () => {
    const note = buildContextNote(
      { key: SCOPE, name: 'main' },
      store,
      memory,
      undefined,
      workstreams,
    );
    expect(note).not.toContain('<workstreams>');
  });

  it('injects the compact index of open work into the prompt', () => {
    workstreams.create(SCOPE, 'reforma de la cocina', 'elegir encimera antes del viernes');
    const note = buildContextNote(
      { key: SCOPE, name: 'main' },
      store,
      memory,
      undefined,
      workstreams,
    );
    expect(note).toContain('<workstreams>');
    expect(note).toContain('reforma de la cocina');
    expect(note).toContain('elegir encimera antes del viernes');
  });

  it('never leaks the work of one conversation into another', () => {
    workstreams.create(SCOPE, 'solo mio', 'ningun otro chat debe verlo');
    const note = buildContextNote(
      { key: 'telegram:main:99#main', name: 'main' },
      store,
      memory,
      undefined,
      workstreams,
    );
    expect(note).not.toContain('solo mio');
  });
});

describe('capturePageIfOpen (captura sin escritorio)', () => {
  it('devuelve la imagen de la página abierta del hilo', async () => {
    const calls: string[] = [];
    const service = {
      isOpen: (scope: string) => scope === 'chat:1',
      screenshot: async (scope: string) => {
        calls.push(scope);
        return { data: Buffer.from('PNGDATA').toString('base64') };
      },
    };
    const png = await capturePageIfOpen(service, 'chat:1');
    expect(png?.toString()).toBe('PNGDATA');
    expect(calls).toEqual(['chat:1']);
  });

  it('no abre nada ni fotografía si no hay página abierta', async () => {
    let shot = 0;
    const service = {
      isOpen: () => false,
      screenshot: async () => {
        shot++;
        return { data: '' };
      },
    };
    expect(await capturePageIfOpen(service, 'chat:2')).toBeNull();
    expect(shot).toBe(0);
  });
});

describe('contextual anticipation: resolved vs missing', () => {
  const note = () =>
    buildContextNote({ key: SCOPE, name: 'main' }, store, memory, undefined, workstreams);

  it('shows what is already resolved and the limits, so it is not re-asked', () => {
    const id = workstreams.create(SCOPE, 'cena del sábado', 'cenar con amigos');
    workstreams.update(id, {
      decisions: 'sitio: casa de Ana; hora: 21:00',
      constraints: 'sin gluten',
      nextSteps: 'decidir quién trae el postre',
    });
    const n = note();
    expect(n).toContain(
      'dicho por el usuario (intención no verificada; confirma antes de actuar si importa): sitio: casa de Ana; hora: 21:00',
    );
    expect(n).toContain('límites: sin gluten');
    expect(n).toContain('siguiente: decidir quién trae el postre');
  });

  it('does not invent a resolved item when nothing was decided (multi-turn)', () => {
    const id = workstreams.create(SCOPE, 'cena del sábado', 'cenar con amigos');
    expect(note()).not.toContain('si importa):');
    workstreams.update(id, { nextSteps: 'elegir sitio' });
    expect(note()).not.toContain('si importa):');
    workstreams.update(id, { decisions: 'sitio: casa de Ana' });
    expect(note()).toContain(
      'dicho por el usuario (intención no verificada; confirma antes de actuar si importa): sitio: casa de Ana',
    );
  });

  it('a resolved decision stays out of the prompt once the work is forgotten', () => {
    const id = workstreams.create(SCOPE, 'cena del sábado', 'cenar');
    workstreams.update(id, { decisions: 'sitio: casa de Ana' });
    workstreams.forget(id);
    const n = note();
    expect(n).not.toContain('casa de Ana');
    expect(n).not.toContain('<anticipation>');
  });

  it('carries the anticipation rules only while there is open work', () => {
    expect(note()).not.toContain('<anticipation>');
    workstreams.create(SCOPE, 'cena del sábado', 'cenar');
    const n = note();
    expect(n).toContain('<anticipation>');
    expect(n).toContain('pregunta SOLO por ese hueco');
    expect(n).toContain('no interrumpas');
    expect(n).toContain('no verificado');
  });

  it('clips very long decisions so the prompt stays compact', () => {
    const id = workstreams.create(SCOPE, 'x', 'y');
    workstreams.update(id, { decisions: 'd'.repeat(2000) });
    expect(note().length).toBeLessThan(2000);
  });
});

describe('decision tool -> ledger -> prompt (real tool path)', () => {
  const run = async (
    text: string | undefined,
    args: Record<string, unknown>,
    scope = SCOPE,
  ): Promise<{ text: string; isError: boolean }> => {
    const ledger = new DecisionLedger(workDb, workstreams);
    const tool = createDecisionTool({
      ledger,
      workstreams,
      scopeOf: () => scope,
      inbound: () =>
        text === undefined
          ? undefined
          : {
              messageId: 'm9',
              userId: 'u1',
              text,
              receivedAt: '2026-10-24T10:00:00Z',
              authorised: true,
              scope,
            },
    });
    const res = await tool.execute('t', args as never);
    const first = res.content[0];
    return { text: first && 'text' in first ? first.text : '', isError: Boolean(res.isError) };
  };
  const note = () =>
    buildContextNote({ key: SCOPE, name: 'main' }, store, memory, undefined, workstreams);

  it('registers a verified decision and the prompt shows it; negation and example do not', async () => {
    const id = workstreams.create(SCOPE, 'cena', 'cenar con amigos');
    const bad = await run('no quiero cenar en casa de Ana', {
      action: 'registrar',
      frente: id,
      resumen: 'sitio: casa de Ana',
      cita: 'cenar en casa de Ana',
    });
    expect(bad.isError).toBe(true);
    const ex = await run('Ejemplo de otro bot: cenamos en casa de Ana', {
      action: 'registrar',
      frente: id,
      resumen: 'sitio: casa de Ana',
      cita: 'cenamos en casa de Ana',
    });
    expect(ex.isError).toBe(true);
    expect(note()).not.toContain('si importa):');
    const ok = await run('Vale, cenamos en casa de Ana.', {
      action: 'registrar',
      frente: id,
      resumen: 'sitio: casa de Ana',
      cita: 'cenamos en casa de Ana',
    });
    expect(ok.isError).toBe(false);
    expect(note()).toContain(
      'dicho por el usuario (intención no verificada; confirma antes de actuar si importa): sitio: casa de Ana',
    );
  });

  it('cannot touch a workstream of another chat, and tentative never shows as resolved', async () => {
    const id = workstreams.create(SCOPE, 'cena', 'cenar');
    const other = await run(
      'cenamos en casa de Ana',
      {
        action: 'registrar',
        frente: id,
        resumen: 'x',
        cita: 'cenamos en casa de Ana',
      },
      'telegram:main:99#main',
    );
    expect(other.isError).toBe(true);
    const t = await run(undefined, {
      action: 'tentativa',
      frente: id,
      resumen: 'quizá casa de Ana',
    });
    expect(t.isError).toBe(false);
    expect(note()).not.toContain('si importa):');
    const none = await run(undefined, {
      action: 'registrar',
      frente: id,
      resumen: 'x',
      cita: 'cenamos en casa de Ana',
    });
    expect(none.isError).toBe(true);
  });
});
