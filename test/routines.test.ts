import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Routine, Store } from '../src/db.js';
import { Store as RealStore } from '../src/db.js';
import { log } from '../src/log.js';
import {
  procedurePrompt,
  RoutineRunner,
  summarizeRoutine,
  validateSchedule,
} from '../src/routines.js';

// Keeps a throwing or spamming routine out of the real log dir while leaving the
// warnings assertable.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'telegram:main:1';

let dir = '';
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-routines-'));
  store = new RealStore(join(dir, 'test.db'));
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function warnings(): string[] {
  return vi.mocked(log.warn).mock.calls.map((call) => String(call[0]));
}

/** The `err` field as the runner logged it; JSON.stringify drops Error internals. */
function errorMessages(): string[] {
  return vi.mocked(log.error).mock.calls.map((call) => {
    const fields = call[1] as { err?: unknown } | undefined;
    const err = fields?.err;
    return err instanceof Error ? err.message : String(err ?? '');
  });
}

function scheduleRoutine(
  overrides: Partial<Routine> & { name: string; schedule: string },
): Routine {
  return store.saveRoutine({
    scope: SCOPE,
    kind: 'schedule',
    prompt: 'check the trains',
    ...overrides,
  });
}

function procedureRoutine(overrides: Partial<Routine> & { name: string; steps: string }): Routine {
  return store.saveRoutine({
    scope: SCOPE,
    kind: 'procedure',
    ...overrides,
  });
}

/**
 * `saveRoutine` always stamps createdAt with now, so the only way to see a
 * routine that has been around for a week is to reach into the row the way a
 * restart days later would.
 */
function backdate(name: string, iso: string): void {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(join(dir, 'test.db'));
  db.prepare('UPDATE routines SET created_at = ? WHERE name = ?').run(iso, name);
  db.close();
}

describe('validateSchedule', () => {
  it('accepts 5-field cron and reports the next fire', () => {
    const result = validateSchedule('*/5 * * * *');
    expect(result.ok).toBe(true);
    expect(result.ok && result.next).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2} \(in [^)]+\)$/,
    );
  });

  it('accepts a 6-field form and treats the first field as seconds', () => {
    const result = validateSchedule('0 * * * * *');
    expect(result.ok).toBe(true);
    // Seconds pinned to :00 every minute is what "0" in the seconds slot means;
    // read as minutes it would be a schedule that never matched the current hour.
    expect(result.ok && result.next).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00 UTC[+-]\d{2}:\d{2} /,
    );
  });

  it('rejects a wrong field count with a message that names the two shapes', () => {
    const result = validateSchedule('every 5 minutes');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/5 fields/);
    expect(!result.ok && result.error).toMatch(/6 with seconds first/);
    expect(!result.ok && result.error).toMatch(/got 3/);
    expect(!result.ok && result.error).toMatch(/every 5 minutes/);
  });

  it('rejects a 7-field form that config.ts would also refuse', () => {
    expect(validateSchedule('0 0 3 * * * 2030').ok).toBe(false);
  });

  it('passes the croner parse error through for out-of-range fields', () => {
    const result = validateSchedule('99 99 * * *');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/99/);
  });

  it('refuses a pattern that parses but never fires', () => {
    const result = validateSchedule('0 0 30 2 *');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/never fires/);
  });

  it('refuses a zero step rather than silently accepting it', () => {
    expect(validateSchedule('*/0 * * * *').ok).toBe(false);
  });
});

describe('RoutineRunner', () => {
  it('registers one job per enabled schedule and nothing for procedures', () => {
    scheduleRoutine({ name: 'trains', schedule: '*/5 * * * *' });
    scheduleRoutine({ name: 'off', schedule: '*/5 * * * *', enabled: false });
    procedureRoutine({ name: 'handmade', steps: '1. open the app' });
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    try {
      const status = runner.status();
      expect(status.map((s) => s.name)).toEqual(['trains']);
      expect(status[0]?.next).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      runner.stop();
    }
  });

  it('picks up a routine created mid-session through sync()', () => {
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    try {
      expect(runner.status()).toEqual([]);
      scheduleRoutine({ name: 'late', schedule: '*/5 * * * *' });
      runner.sync();
      expect(runner.status().map((s) => s.name)).toEqual(['late']);
      store.deleteRoutine(SCOPE, 'late');
      runner.sync();
      expect(runner.status()).toEqual([]);
    } finally {
      runner.stop();
    }
  });

  it('holds back the first fire of a routine that was just created', () => {
    const created = scheduleRoutine({ name: 'every-second', schedule: '* * * * * *' });
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    try {
      const held = runner.status()[0];
      expect(held?.startAt).toBeTruthy();
      const cooldown = Date.parse(created.createdAt) + 60_000;
      expect(held?.startAt).toBe(new Date(cooldown).toISOString());
      expect(Date.parse(held?.next ?? '1970-01-01')).toBeGreaterThanOrEqual(cooldown);
      expect(warnings().some((msg) => msg.includes('just created'))).toBe(true);
    } finally {
      runner.stop();
    }
  });

  it('does not hold back a routine that has been around for days', () => {
    scheduleRoutine({ name: 'old', schedule: '*/5 * * * *' });
    backdate('old', new Date(Date.now() - 3 * 86_400_000).toISOString());
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    try {
      expect(runner.status()[0]?.startAt).toBeNull();
      expect(warnings().some((msg) => msg.includes('just created'))).toBe(false);
    } finally {
      runner.stop();
    }
  });

  it('skips a tick while the previous run of the same routine is still going', async () => {
    scheduleRoutine({ name: 'slow', schedule: '*/5 * * * *' });
    let concurrent = 0;
    let peak = 0;
    let calls = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new RoutineRunner({
      store,
      timeoutMs: 5_000,
      run: async () => {
        calls++;
        concurrent++;
        peak = Math.max(peak, concurrent);
        await gate;
        concurrent--;
      },
    });

    const first = runner.fire(SCOPE, 'slow');
    await Promise.resolve();
    const second = await runner.fire(SCOPE, 'slow');
    expect(second).toBe(false);
    expect(runner.isRunning(SCOPE, 'slow')).toBe(true);
    expect(warnings().some((msg) => msg.includes('previous run still going'))).toBe(true);
    release();
    expect(await first).toBe(true);
    expect(peak).toBe(1);
    expect(calls).toBe(1);
    expect(runner.isRunning(SCOPE, 'slow')).toBe(false);
  });

  it('lets a different routine run while one is busy', async () => {
    scheduleRoutine({ name: 'slow', schedule: '*/5 * * * *' });
    scheduleRoutine({ name: 'quick', schedule: '*/5 * * * *' });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const names: string[] = [];
    const runner = new RoutineRunner({
      store,
      timeoutMs: 5_000,
      run: async (_prompt, ctx) => {
        names.push(ctx.routine.name);
        if (ctx.routine.name === 'slow') await gate;
      },
    });
    const slow = runner.fire(SCOPE, 'slow');
    await Promise.resolve();
    expect(await runner.fire(SCOPE, 'quick')).toBe(true);
    release();
    await slow;
    expect(names).toEqual(['slow', 'quick']);
  });

  it('logs a throwing routine and keeps the scheduler alive', async () => {
    scheduleRoutine({ name: 'boom', schedule: '*/5 * * * *' });
    let calls = 0;
    const runner = new RoutineRunner({
      store,
      timeoutMs: 5_000,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error('provider exploded');
      },
    });
    await expect(runner.fire(SCOPE, 'boom')).resolves.toBe(true);
    expect(errorMessages().some((msg) => msg.includes('provider exploded'))).toBe(true);
    // The failure must not leave the slot locked.
    expect(runner.isRunning(SCOPE, 'boom')).toBe(false);
    await expect(runner.fire(SCOPE, 'boom')).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it('logs a routine that throws before returning a promise', async () => {
    scheduleRoutine({ name: 'sync-throw', schedule: '*/5 * * * *' });
    const runner = new RoutineRunner({
      store,
      timeoutMs: 5_000,
      run: () => {
        throw new Error('threw immediately');
      },
    });
    await expect(runner.fire(SCOPE, 'sync-throw')).resolves.toBe(true);
    expect(
      vi.mocked(log.error).mock.calls.some((call) => /threw before/.test(String(call[0]))),
    ).toBe(true);
    expect(runner.isRunning(SCOPE, 'sync-throw')).toBe(false);
  });

  it('times out a hanging routine instead of waiting on it forever', async () => {
    scheduleRoutine({ name: 'hang', schedule: '*/5 * * * *' });
    const runner = new RoutineRunner({
      store,
      timeoutMs: 150,
      run: () => new Promise<void>(() => {}),
    });
    const startedAt = Date.now();
    await expect(runner.fire(SCOPE, 'hang')).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(warnings().some((msg) => msg.includes('timed out'))).toBe(true);
    // The work is still going, so the slot must stay held: releasing it here
    // would let the next tick stack another copy on top of the hung one.
    expect(runner.isRunning(SCOPE, 'hang')).toBe(true);
    expect(await runner.fire(SCOPE, 'hang')).toBe(false);
  });

  it('refuses to fire an unknown or disabled routine', async () => {
    scheduleRoutine({ name: 'off', schedule: '*/5 * * * *', enabled: false });
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    expect(await runner.fire(SCOPE, 'nope')).toBe(false);
    expect(await runner.fire(SCOPE, 'off')).toBe(false);
  });

  it('marks the routine as run and hands the agent the stored prompt', async () => {
    const routine = scheduleRoutine({
      name: 'trains',
      schedule: '*/5 * * * *',
      prompt: 'check the trains',
    });
    const seen: string[] = [];
    const runner = new RoutineRunner({
      store,
      timeoutMs: 5_000,
      run: async (prompt) => {
        seen.push(prompt);
      },
    });
    await runner.fire(SCOPE, 'trains');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('check the trains');
    expect(store.getRoutine(SCOPE, 'trains')?.lastRunAt).toBeTruthy();
    expect(routine.name).toBe('trains');
  });

  it('skips a routine whose stored schedule no longer parses', () => {
    // Reachable by writing the row directly: the store does not validate cron.
    scheduleRoutine({ name: 'broken', schedule: 'not a cron at all' });
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
    try {
      expect(runner.status()).toEqual([]);
      expect(warnings().some((msg) => msg.includes('not scheduled'))).toBe(true);
    } finally {
      runner.stop();
    }
  });

  it('stops the jobs so nothing fires after stop()', async () => {
    scheduleRoutine({ name: 'trains', schedule: '* * * * * *' });
    let calls = 0;
    const runner = new RoutineRunner({
      store,
      timeoutMs: 5_000,
      run: async () => {
        calls++;
      },
    });
    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    runner.stop();
    expect(runner.status()).toEqual([]);
    const seen = calls;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(calls).toBe(seen);
  });

  it('ignores sync() before start()', () => {
    scheduleRoutine({ name: 'trains', schedule: '*/5 * * * *' });
    const runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.sync();
    expect(runner.status()).toEqual([]);
  });
});

describe('routine text', () => {
  const base: Routine = {
    id: 'r1',
    scope: SCOPE,
    name: 'renfe',
    kind: 'schedule',
    params: null,
    steps: null,
    prompt: 'check the trains from Atocha',
    schedule: '*/10 * * * *',
    enabled: true,
    createdAt: '2026-09-30T08:00:00.000Z',
    updatedAt: '2026-09-30T08:00:00.000Z',
    lastRunAt: '2026-10-01T08:00:00.000Z',
  };

  it('summarizes a schedule for the agent and for the user', () => {
    const text = summarizeRoutine(base);
    expect(text).toContain('"renfe"');
    expect(text).toContain('*/10 * * * *');
    expect(text).toContain('check the trains from Atocha');
    expect(text).toMatch(/stored routine/i);
    expect(text).toMatch(/not a fresh instruction/i);
    expect(text).toContain('2026-10-01T08:00:00.000Z');
  });

  it('summarizes a procedure with its steps', () => {
    const text = summarizeRoutine({ ...base, kind: 'procedure', steps: '1. open renfe\n2. buy' });
    expect(text).toContain('Steps:');
    expect(text).toContain('1. open renfe');
  });

  it('renders a procedure as an instruction with the credential rule still in it', () => {
    const text = procedurePrompt({
      ...base,
      kind: 'procedure',
      steps: '1. open the app\n2. press go',
    });
    expect(text).toContain('"renfe"');
    expect(text).toContain('1. open the app');
    expect(text).toMatch(/never type a password/i);
    expect(text).toMatch(/not permission/i);
    expect(text).toMatch(/calling done/i);
  });

  it('says so when a procedure has no steps recorded', () => {
    expect(procedurePrompt({ ...base, kind: 'procedure' })).toMatch(/no steps were recorded/);
  });
});
