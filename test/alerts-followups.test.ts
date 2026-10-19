// Historia de usuario Hermes ("drafts a follow-up when something has been
// sitting unsigned"; "finds the exceptions that need a human"): el tracker de
// seguimientos (src/alerts/followups.ts) esta cableado en cli.ts pero no tenia
// suite propia. Estos tests fijan su contrato real contra SQLite en memoria:
// promesas con fecha, silencios por contacto, reloj inyectado y resumen en
// espanol acotado para no spamear.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Ancla fija: un martes cualquiera; el reloj inyectado parte de aqui. */
const T0 = 1_760_000_000_000;

function makeTracker(opts: { windowHours?: number; now?: () => number } = {}) {
  const db = new DatabaseSync(':memory:');
  const tracker = new FollowupTracker({ db, ...opts });
  return { db, tracker };
}

describe('FollowupTracker track + due', () => {
  it('una promesa cuya fecha ya llego aparece en due(); una futura no', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    tracker.track('s', 'date', 'entregar el informe', T0 - HOUR);
    tracker.track('s', 'date', 'renovar el dominio', T0 + DAY);
    const due = tracker.due(T0);
    expect(due.map((f) => f.subject)).toEqual(['entregar el informe']);
  });

  it('due() ignora notas resueltas', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    const id = tracker.track('s', 'date', 'entregar el informe', T0 - HOUR);
    tracker.resolve(id);
    expect(tracker.due(T0)).toEqual([]);
  });

  it('re-trackear la misma promesa actualiza la fecha y la reabre', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    const id = tracker.track('s', 'date', 'entregar el informe', T0 - HOUR);
    tracker.resolve(id);
    const id2 = tracker.track('s', 'date', 'entregar el informe', T0 + 2 * DAY);
    expect(id2).toBe(id);
    const due = tracker.due(T0);
    expect(due).toEqual([]);
    expect(tracker.list()[0]).toMatchObject({ status: 'pending', dueAt: T0 + 2 * DAY });
  });

  it('una nota sin fecha (dueAt = 0) nunca sale como vencida; solo por silencio', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    tracker.track('s', 'contact', 'responder a Juan', 0);
    expect(tracker.due(T0 + 30 * DAY)).toEqual([]);
    expect(tracker.overdue(3, T0 + 5 * DAY).map((f) => f.subject)).toEqual(['responder a Juan']);
  });
});

describe('FollowupTracker silencios (overdue)', () => {
  it('un asunto sin tocar mas alla de la ventana aparece; uno reciente no', () => {
    let clock = T0;
    const { tracker } = makeTracker({ windowHours: 72, now: () => clock });
    tracker.track('s', 'contact', 'responder a Juan', T0);
    tracker.track('s', 'contact', 'responder a Maria', T0);
    clock = T0 + 4 * DAY;
    tracker.touch('s', 'responder a Maria');
    clock = T0 + 4 * DAY + HOUR;
    const late = tracker.overdue(undefined, clock);
    expect(late.map((f) => f.subject)).toEqual(['responder a Juan']);
  });

  it('touch() no resucita notas resueltas', () => {
    let clock = T0;
    const { tracker } = makeTracker({ now: () => clock });
    const id = tracker.track('s', 'contact', 'responder a Juan', T0);
    tracker.resolve(id);
    clock = T0 + 10 * DAY;
    tracker.touch('s', 'responder a Juan');
    expect(tracker.list()[0]?.lastContact).toBe(T0);
    expect(tracker.overdue(undefined, clock)).toEqual([]);
  });

  it('respeta una ventana en dias pasada a overdue()', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    tracker.track('s', 'contact', 'responder a Juan', T0);
    expect(tracker.overdue(1, T0 + 2 * DAY).length).toBe(1);
    expect(tracker.overdue(3, T0 + 2 * DAY).length).toBe(0);
  });
});

describe('FollowupTracker summarize', () => {
  it('sin pendientes dice que esta todo al dia', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    expect(tracker.summarize(T0)).toBe('Todo al día.');
  });

  it('mezcla vencimientos y silencios, acotado a 3 lineas con conteo del resto', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    for (let i = 1; i <= 4; i++) {
      tracker.track('s', 'date', `tarea ${i}`, T0 - i * HOUR);
    }
    const text = tracker.summarize(T0);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Vence: tarea 4');
    expect(lines.filter((l) => l.startsWith('Vence:')).length).toBe(3);
    expect(lines.at(-1)).toBe('…y 1 más.');
  });

  it('un silencio reporta los dias redondeados y no duplica un vencimiento', () => {
    const { tracker } = makeTracker({ now: () => T0 });
    tracker.track('s', 'contact', 'responder a Juan', 0);
    tracker.track('s', 'date', 'entregar el informe', T0);
    const text = tracker.summarize(T0 + 5 * DAY);
    const lines = text.split('\n');
    expect(lines).toContain('Vence: entregar el informe');
    expect(lines).toContain('Llevas 5 d sin tocar: responder a Juan');
    expect(lines.filter((l) => l.includes('entregar el informe')).length).toBe(1);
  });
});

describe('FollowupTracker list y safe', () => {
  it('list filtra por scope y respeta el limite, mas reciente primero', () => {
    let clock = T0;
    const { tracker } = makeTracker({ now: () => clock });
    tracker.track('a', 'date', 'primero', T0);
    clock = T0 + HOUR;
    tracker.track('a', 'date', 'segundo', T0);
    tracker.track('b', 'date', 'de otro scope', T0);
    expect(tracker.list('a').map((f) => f.subject)).toEqual(['segundo', 'primero']);
    expect(tracker.list(undefined, 1).length).toBe(1);
  });

  it('safe() devuelve el fallback cuando el tracker falla', () => {
    const { db, tracker } = makeTracker();
    db.close();
    expect(tracker.safe(() => tracker.summarize(), 'fallback')).toBe('fallback');
  });
});
