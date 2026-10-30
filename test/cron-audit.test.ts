import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';
import { ActionLog } from '../src/audit/log.js';
import { parseNatural } from '../src/cron/scheduler.js';

// The scheduler reads cron fields in local time, so expectations built with the local
// `Date` constructor would silently pass for a UTC implementation on a UTC machine.
// Pinning Europe/Madrid — UTC+2 in October 2026, with real DST changes in March and
// October — makes the assertions mean the same thing on every machine.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Europe/Madrid';

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

describe('parseNatural', () => {
  it('turns spoken schedules into expressions', () => {
    expect(parseNatural('cada mañana a las 8 un resumen de mi día')?.schedule).toBe('0 8 * * *');
    expect(parseNatural('cada noche a las 22:30 revisa el correo')?.schedule).toBe('30 22 * * *');
    expect(parseNatural('los lunes a las 9 prepara el informe')?.schedule).toBe('0 9 * * 1');
    expect(parseNatural('cada hora comprueba la temperatura')?.schedule).toBe('0 * * * *');
    expect(parseNatural('cada 5 minutos avisa si sube la temperatura')?.schedule).toBe(
      '*/5 * * * *',
    );
    expect(parseNatural('cada 2 horas recuerda beber agua')?.schedule).toBe('0 */2 * * *');
    expect(parseNatural('los viernes a las 18 haz la revisión')?.schedule).toBe('0 18 * * 5');
  });

  it('moves an afternoon hour into the evening, as people speak', () => {
    expect(parseNatural('cada tarde a las 6 avísame')?.schedule).toBe('0 18 * * *');
  });

  it('rejects a sentence with no schedule and keeps the prompt intact', () => {
    expect(parseNatural('hola qué tal')).toBeNull();
    expect(parseNatural('cada mañana a las 8 un resumen')?.prompt).toBe(
      'cada mañana a las 8 un resumen',
    );
  });
});

describe('FollowupTracker', () => {
  let db: DatabaseSync;
  let tracker: FollowupTracker;
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const day = 86_400_000;
  let clock = now;

  beforeEach(() => {
    clock = now;
    db = new DatabaseSync(':memory:');
    tracker = new FollowupTracker({ db, now: () => clock });
  });
  afterEach(() => db.close());

  it('reports what is due and what has been left alone', () => {
    tracker.track('chat', 'date', 'la matrícula vence el viernes', now - 1000);
    tracker.track('chat', 'contact', 'responder a Juan', now);
    expect(tracker.due(now).map((f) => f.subject)).toContain('la matrícula vence el viernes');
    // Nothing is overdue yet: both were tracked a moment ago.
    expect(tracker.overdue(3, now)).toHaveLength(0);
    // Four days of silence is enough to be worth mentioning.
    clock = now + 4 * day;
    expect(tracker.overdue(3, clock)).toHaveLength(2);
  });

  it('restarts the silence clock on contact', () => {
    tracker.track('chat', 'contact', 'responder a Juan', now);
    tracker.touch('chat', 'responder a Juan');
    expect(tracker.overdue(3, now + 2 * day)).toHaveLength(0);
    expect(tracker.overdue(3, now + 4 * day)).toHaveLength(1);
  });

  it('resolves without losing the record and updates instead of duplicating', () => {
    const id = tracker.track('chat', 'date', 'comprar regalo', now + day);
    tracker.track('chat', 'date', 'comprar regalo', now + 2 * day);
    expect(tracker.list('chat')).toHaveLength(1);
    tracker.resolve(id);
    expect(tracker.due(now + 2 * day)).toHaveLength(0);
    expect(tracker.list('chat').find((f) => f.id === id)?.status).toBe('done');
  });

  it('summarises in Spanish and bounds the list', () => {
    expect(tracker.summarize(now)).toBe('Todo al día.');
    for (let i = 0; i < 5; i++) tracker.track('chat', 'date', `cosa ${i}`, now - i * 1000);
    const text = tracker.summarize(now);
    expect(text).toMatch(/Vence: cosa 4/);
    expect(text).toMatch(/…y \d+ más/);
    expect(text.split('\n')).toHaveLength(4);
  });
});

describe('ActionLog', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-audit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends one JSON object per line and reads them back oldest first', () => {
    const log = new ActionLog({ file: join(dir, 'a.jsonl') });
    log.record({ actor: 'agent', action: 'send', target: 'telegram', result: 'ok' });
    log.record({ actor: 'agent', action: 'delete', target: 'tmp/x', result: 'blocked' });
    const recent = log.recent();
    // `recent` returns the newest N in file order, so the earlier entry comes first.
    expect(recent).toHaveLength(2);
    expect(recent[0]?.action).toBe('send');
    expect(recent[1]?.action).toBe('delete');
  });

  it('filters and summarises in Spanish', () => {
    const log = new ActionLog({ file: join(dir, 'b.jsonl') });
    for (let i = 0; i < 6; i++) {
      log.record({
        actor: 'agent',
        action: 'send',
        target: `t${i}`,
        result: i % 2 ? 'error' : 'ok',
      });
    }
    expect(log.recent(3)).toHaveLength(3);
    expect(log.recent(50, { result: 'error' })).toHaveLength(3);
    const summary = log.summary(24);
    expect(summary).toMatch(/6 \(errores: 3/);
  });
});
