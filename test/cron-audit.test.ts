import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';
import { ActionLog } from '../src/audit/log.js';
import {
  nextCronRun,
  PromptCron,
  parseCronExpression,
  parseNatural,
} from '../src/cron/scheduler.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

describe('parseCronExpression', () => {
  it('accepts five fields and six, and rejects anything else', () => {
    expect(parseCronExpression('*/5 * * * *')).not.toBeNull();
    expect(parseCronExpression('0 30 8 * * *')).not.toBeNull();
    expect(parseCronExpression('0 8 * * * * *')).toBeNull();
    expect(parseCronExpression('0 8 * *')).toBeNull();
  });

  it('parses stars, ranges, lists and steps', () => {
    const parsed = parseCronExpression('0,15,30 8-17 * * 1-5');
    expect(parsed?.minutes).toEqual([0, 15, 30]);
    expect(parsed?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronExpression('*/15 * * * *')?.minutes).toEqual([0, 15, 30, 45]);
  });

  it('treats day-of-week 7 as Sunday and rejects out of range', () => {
    expect(parseCronExpression('0 8 * * 7')?.daysOfWeek).toEqual([0]);
    expect(parseCronExpression('0 24 * * *')).toBeNull();
    expect(parseCronExpression('61 * * * *')).toBeNull();
  });
});

describe('nextCronRun', () => {
  const schedule = parseCronExpression('0 8 * * *');
  const monday = Date.UTC(2026, 9, 5, 0, 0, 0);

  it('finds the next matching minute and skips ahead when past', () => {
    expect(nextCronRun(schedule as never, monday)).toBe(Date.UTC(2026, 9, 5, 8, 0, 0));
    expect(nextCronRun(schedule as never, Date.UTC(2026, 9, 5, 9, 0, 0))).toBe(
      Date.UTC(2026, 9, 6, 8, 0, 0),
    );
  });

  it('honours the day of the week', () => {
    const mondayOnly = parseCronExpression('0 8 * * 1');
    expect(nextCronRun(mondayOnly as never, Date.UTC(2026, 9, 2))).toBe(
      Date.UTC(2026, 9, 5, 8, 0, 0),
    );
  });
});

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

describe('PromptCron', () => {
  it('fires once per minute even across several ticks', async () => {
    const fired: string[] = [];
    let now = Date.UTC(2026, 9, 5, 7, 59, 50);
    const cron = new PromptCron({
      jobs: [{ id: 'a', schedule: '0 8 * * *', prompt: 'p', chatId: '1' }],
      run: async (job) => {
        fired.push(job.id);
      },
      now: () => now,
      tickMs: 50,
    });
    cron.start();
    now = Date.UTC(2026, 9, 5, 8, 0, 10);
    await new Promise((r) => setTimeout(r, 200));
    now = Date.UTC(2026, 9, 5, 8, 0, 30);
    await new Promise((r) => setTimeout(r, 200));
    cron.stop();
    expect(fired).toEqual(['a']);
  });

  it('reports the next run and keeps going after a job throws', async () => {
    const fired: string[] = [];
    let now = Date.UTC(2026, 9, 5, 7, 0, 0);
    const cron = new PromptCron({
      jobs: [
        { id: 'a', schedule: '0 8 * * *', prompt: 'p', chatId: '1' },
        { id: 'bad', schedule: 'nope', prompt: 'p', chatId: '1' },
      ],
      run: async (job) => {
        fired.push(job.id);
        throw new Error('boom');
      },
      now: () => now,
      tickMs: 50,
    });
    expect(cron.nextRun('a')?.toISOString()).toBe('2026-10-05T08:00:00.000Z');
    expect(cron.nextRun('bad')).toBeNull();
    expect(cron.size).toBe(2);

    cron.start();
    now = Date.UTC(2026, 9, 5, 8, 0, 10);
    await new Promise((r) => setTimeout(r, 250));
    cron.stop();
    // A throwing job does not silence the scheduler.
    expect(fired).toContain('a');
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
