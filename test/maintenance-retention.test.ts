import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_RETENTION_DAYS,
  retentionIfDue,
  sessionRetentionDays,
} from '../src/maintenance.js';
import { SessionStore } from '../src/memory/sessions.js';

const DAY = 24 * 3_600_000;

function dbWith(rows: Array<{ id: string; startedAgoDays: number; ended: boolean }>, now: Date) {
  const db = new DatabaseSync(':memory:');
  new SessionStore({ db });
  for (const r of rows) {
    const started = now.getTime() - r.startedAgoDays * DAY;
    db.prepare(
      'INSERT INTO sessions (id, scope, title, started_at, ended_at, summary) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(r.id, 'telegram:1', r.id, started, r.ended ? started + 1000 : null, 's');
    db.prepare('INSERT INTO session_turns (session_id, role, text, at) VALUES (?, ?, ?, ?)').run(
      r.id,
      'user',
      'hola',
      started,
    );
  }
  return db;
}

const ids = (db: DatabaseSync): string[] =>
  (db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>).map(
    (r) => r.id,
  );

describe('retención de sesiones (pasada diaria del daemon)', () => {
  const now = new Date(2026, 9, 30, 4, 30); // 04:30 local
  const rows = [
    { id: 'vieja-terminada', startedAgoDays: 400, ended: true },
    { id: 'vieja-abierta', startedAgoDays: 400, ended: false },
    { id: 'reciente', startedAgoDays: 10, ended: true },
  ];

  it('borra solo las terminadas más antiguas que la retención, y sus turnos', () => {
    const db = dbWith(rows, now);
    let marked = 0;
    const r = retentionIfDue({
      db,
      now,
      lastRunMs: 0,
      markRun: (at) => {
        marked = at;
      },
      env: {},
    });
    expect(r).toEqual({ ran: true, sessions: 1 });
    expect(marked).toBe(now.getTime());
    expect(ids(db)).toEqual(['reciente', 'vieja-abierta']);
    const turns = db
      .prepare("SELECT COUNT(*) AS n FROM session_turns WHERE session_id = 'vieja-terminada'")
      .get() as { n: number };
    expect(turns.n).toBe(0);
  });

  it('una vez al día y no antes de las 04:00 (después de la copia de las 03:00)', () => {
    const db = dbWith(rows, now);
    const early = new Date(2026, 9, 30, 3, 50);
    expect(retentionIfDue({ db, now: early, lastRunMs: 0, markRun: () => {}, env: {} }).ran).toBe(
      false,
    );
    const ranAt = now.getTime() - 2 * 3_600_000;
    expect(retentionIfDue({ db, now, lastRunMs: ranAt, markRun: () => {}, env: {} }).ran).toBe(
      false,
    );
    expect(ids(db)).toHaveLength(3);
  });

  it('PA_SESSION_RETENTION_DAYS=0 la apaga; valores raros usan 365', () => {
    const db = dbWith(rows, now);
    const off = { PA_SESSION_RETENTION_DAYS: '0' };
    expect(retentionIfDue({ db, now, lastRunMs: 0, markRun: () => {}, env: off }).ran).toBe(false);
    expect(ids(db)).toHaveLength(3);
    expect(sessionRetentionDays({})).toBe(DEFAULT_SESSION_RETENTION_DAYS);
    expect(sessionRetentionDays({ PA_SESSION_RETENTION_DAYS: 'abc' })).toBe(365);
    expect(sessionRetentionDays({ PA_SESSION_RETENTION_DAYS: '-3' })).toBe(365);
    expect(sessionRetentionDays({ PA_SESSION_RETENTION_DAYS: ' 30 ' })).toBe(30);
  });
});

describe('cableado en el daemon', () => {
  const cli = readFileSync('src/cli.ts', 'utf8');

  it('el tick de 10 min del daemon ejecuta la retención', () => {
    const tick = cli.slice(cli.indexOf('const pageWatchTimer = setInterval('));
    const body = tick.slice(0, tick.indexOf('10 * 60 * 1000'));
    expect(body).toContain('retentionTick();');
  });

  it('retentionTick llama a retentionIfDue con la base de memoria y el estado persistido', () => {
    const fn = cli.slice(cli.indexOf('const retentionTick = ()'));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    expect(body).toContain('retentionIfDue({');
    expect(body).toContain('db: memoryDb');
    expect(body).toContain("weeklyState.lastSent('retencion')");
  });
});
