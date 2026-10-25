import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUSH_WINDOW_MS, FollowupTracker } from '../src/alerts/followups.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 1_760_000_000_000;

const dirs: string[] = [];

function memoryTracker(now = () => T0): FollowupTracker {
  return new FollowupTracker({ db: new DatabaseSync(':memory:'), now });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('FollowupTracker dueForPush', () => {
  it('incluye vencidas y próximas dentro de la ventana, ordenadas por fecha', () => {
    const tracker = memoryTracker();
    tracker.track('s', 'date', 'en siete horas', T0 + 7 * HOUR);
    tracker.track('s', 'date', 'vencida', T0 - HOUR);
    tracker.track('s', 'date', 'en dos horas', T0 + 2 * HOUR);

    const due = tracker.dueForPush(T0, { windowMs: 6 * HOUR });
    expect(due.map((f) => f.subject)).toEqual(['vencida', 'en dos horas']);
    expect(due[0]?.pushedAt).toBe(0);
  });

  it('la ventana por defecto es de un día', () => {
    const tracker = memoryTracker();
    tracker.track('s', 'date', 'en 23 h', T0 + 23 * HOUR);
    tracker.track('s', 'date', 'en 25 h', T0 + 25 * HOUR);

    expect(DEFAULT_PUSH_WINDOW_MS).toBe(DAY);
    expect(tracker.dueForPush(T0).map((f) => f.subject)).toEqual(['en 23 h']);
  });

  it('una ventana de cero solo empuja lo que ya venció', () => {
    const tracker = memoryTracker();
    tracker.track('s', 'date', 'ahora', T0);
    tracker.track('s', 'date', 'en un minuto', T0 + MINUTE);

    expect(tracker.dueForPush(T0, { windowMs: 0 }).map((f) => f.subject)).toEqual(['ahora']);
  });

  it('marca como empujada y no la repite; la marca persiste en fichero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-followup-push-'));
    dirs.push(dir);
    const file = join(dir, 'agent.db');

    const db = new DatabaseSync(file);
    try {
      const tracker = new FollowupTracker({ db, now: () => T0 });
      const id = tracker.track('s', 'date', 'entregar el informe', T0 - HOUR);
      expect(tracker.dueForPush(T0).map((f) => f.subject)).toEqual(['entregar el informe']);

      tracker.markPushed(id, T0);
      expect(tracker.dueForPush(T0)).toEqual([]);
    } finally {
      db.close();
    }

    const reopened = new DatabaseSync(file);
    try {
      const tracker = new FollowupTracker({ db: reopened, now: () => T0 });
      expect(tracker.dueForPush(T0)).toEqual([]);
      expect(tracker.list()[0]?.pushedAt).toBe(T0);
    } finally {
      reopened.close();
    }
  });

  it('re-trackear con otra fecha reabre el empuje; con la misma no lo repite', () => {
    const tracker = memoryTracker();
    const id = tracker.track('s', 'date', 'renovar el dominio', T0 - HOUR);
    tracker.markPushed(id, T0);
    tracker.track('s', 'date', 'renovar el dominio', T0 - HOUR);
    expect(tracker.dueForPush(T0)).toEqual([]);

    tracker.track('s', 'date', 'renovar el dominio', T0 + 2 * HOUR);
    expect(tracker.dueForPush(T0, { windowMs: 3 * HOUR }).map((f) => f.subject)).toEqual([
      'renovar el dominio',
    ]);
  });

  it('no empuja resueltas ni notas sin fecha', () => {
    const tracker = memoryTracker();
    const id = tracker.track('s', 'date', 'ya está', T0 - HOUR);
    tracker.resolve(id);
    tracker.track('s', 'contact', 'responder a Juan', 0);

    expect(tracker.dueForPush(T0 + 30 * DAY)).toEqual([]);
  });

  it('un instante inválido no empuja nada y markPushed valida su reloj', () => {
    const tracker = memoryTracker();
    tracker.track('s', 'date', 'vencida', T0 - HOUR);
    expect(tracker.dueForPush(Number.NaN)).toEqual([]);
    expect(() => tracker.markPushed('x', -1)).toThrow(/instante/);
  });

  it('migra una base antigua sin pushed_at y sigue empujando lo pendiente', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE followups (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        last_contact INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO followups (id, scope, kind, subject, last_contact, due_at, status, created_at)
       VALUES ('date:antigua', 's', 'date', 'promesa antigua', ?, ?, 'pending', ?)`,
    ).run(T0, T0 - HOUR, T0);

    const tracker = new FollowupTracker({ db, now: () => T0 });
    expect(tracker.dueForPush(T0).map((f) => f.subject)).toEqual(['promesa antigua']);
    db.close();
  });
});
