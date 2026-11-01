import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  formatDurationMs,
  MIN_STALE_MS,
  readHeartbeat,
  runWatchdog,
  staleThresholdMs,
  Watchdog,
} from '../src/watchdog.js';

/**
 * The watchdog is tested with an injected clock and injected files, never a process.
 *
 * That is not a shortcut: a test that killed a real process to prove the watchdog
 * kills processes would be testing `process.kill`, and a test that waited for a real
 * heartbeat would be slow and flaky. What matters here is the decision table — fresh,
 * stale, over budget, out of window, unreadable pid — and every input to it is a value
 * we own.
 */

let dir: string;

/**
 * A fixed "now" far enough from epoch that a heartbeat written ten minutes earlier is
 * still a plausible timestamp. `readHeartbeat` rejects implausible values on purpose
 * (a garbage file must read as old, not as fresh), and a clock sitting right at the
 * sanity boundary would test the parser, not the decision table.
 */
const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-watchdog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function beat(): string {
  return join(dir, 'agent.heartbeat');
}

function writeBeat(at: number): void {
  writeFileSync(beat(), String(at));
}

describe('Watchdog.check', () => {
  it('a fresh heartbeat is healthy and touches nothing', async () => {
    const now = NOW;
    writeBeat(now);
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });

    const verdict = await wd.check();

    expect(verdict.healthy).toBe(true);
    expect(verdict.action).toBe('none');
    expect(verdict.staleMs).toBe(0);
    expect(restarts).toBe(0);
    expect(wd.stats().restarts).toBe(0);
  });

  it('a heartbeat older than the threshold is a dead daemon and restarts it', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    const killed: number[] = [];
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      pidFile: join(dir, 'agent.pid'),
      staleAfterMs: 120_000,
      now: () => now,
      // Hung but alive: it holds the pid file open, so the pid has to go before the
      // restart or `assertNotRunning` refuses the second instance.
      readPid: () => 4242,
      kill: (pid) => {
        killed.push(pid);
      },
      restart: () => {
        restarts += 1;
      },
    });

    const verdict = await wd.check();

    expect(verdict.healthy).toBe(false);
    expect(verdict.action).toBe('restart');
    expect(verdict.staleMs).toBe(10 * 60_000);
    expect(killed).toEqual([4242]);
    expect(restarts).toBe(1);
    expect(wd.stats().restartsInWindow).toBe(1);
  });

  it('a restart budget that runs out stops restarting and reports', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      maxRestarts: 3,
      windowMs: 15 * 60_000,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });

    const first = await wd.check();
    const second = await wd.check();
    const third = await wd.check();
    const fourth = await wd.check();

    expect([first.action, second.action, third.action]).toEqual(['restart', 'restart', 'restart']);
    expect(fourth.gaveUp).toBe(true);
    expect(fourth.action).toBe('report');
    expect(restarts).toBe(3);
    expect(wd.stats().restartsInWindow).toBe(3);
    expect(wd.summary(fourth)).toContain('dejo de reiniciarla');
  });

  it('restarting stays budgeted per window, not per lifetime', async () => {
    let now = NOW;
    writeBeat(now - 10 * 60_000);
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      maxRestarts: 2,
      windowMs: 60_000,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });

    await wd.check();
    await wd.check();
    expect((await wd.check()).gaveUp).toBe(true);
    expect(restarts).toBe(2);

    // One window later the old crashes are history: the budget is a rate, so a daemon
    // that breaks again after a quiet stretch is restarted again.
    now += 61_000;
    const later = await wd.check();
    expect(later.gaveUp).toBe(false);
    expect(later.action).toBe('restart');
    expect(restarts).toBe(3);
    expect(wd.stats().restartsInWindow).toBe(1);
    // The lifetime counter is not the budget: it is the "how many times have I touched
    // this" number a human asks for.
    expect(wd.stats().restarts).toBe(3);
  });

  it('an unreadable pid means nothing is killed and nothing is restarted', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    writeFileSync(join(dir, 'agent.pid'), 'no soy un pid');
    const killed: number[] = [];
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      pidFile: join(dir, 'agent.pid'),
      staleAfterMs: 120_000,
      now: () => now,
      kill: (pid) => {
        killed.push(pid);
      },
      restart: () => {
        restarts += 1;
      },
    });

    const verdict = await wd.check();

    expect(verdict.action).toBe('report');
    expect(verdict.gaveUp).toBe(false);
    expect(verdict.pid).toBeNull();
    expect(verdict.reason).toContain('proceso');
    expect(killed).toEqual([]);
    expect(restarts).toBe(0);
    expect(wd.summary(verdict)).toContain('no toco nada');
  });

  it('status mode reports without killing or restarting', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    let killed = 0;
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      statusOnly: true,
      staleAfterMs: 120_000,
      now: () => now,
      readPid: () => 99,
      kill: () => {
        killed += 1;
      },
      restart: () => {
        restarts += 1;
      },
    });

    const verdict = await wd.check();

    expect(verdict.healthy).toBe(false);
    expect(verdict.action).toBe('report');
    expect(killed).toBe(0);
    expect(restarts).toBe(0);
    expect(wd.summary(verdict)).toContain('modo consulta');
  });

  it('a restart that throws becomes a report, and the failure is kept', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      now: () => now,
      restart: () => {
        throw new Error('schtasks.exe devolvió 1');
      },
    });

    const verdict = await wd.check();

    expect(verdict.action).toBe('report');
    expect(verdict.reason).toBe('intenté reiniciarla y no pude');
    expect(wd.stats().lastError).toContain('schtasks');
  });

  it('a daemon that recovers gets its restart budget back', async () => {
    let now = NOW;
    writeBeat(now - 10 * 60_000);
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      maxRestarts: 2,
      windowMs: 60 * 60_000,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });

    await wd.check();
    expect((await wd.check()).action).toBe('restart');
    expect(restarts).toBe(2);
    expect((await wd.check()).gaveUp).toBe(true);

    // It comes back: a healthy beat wipes the gave-up latch, because a crash-loop that
    // already ended should not block the next real crash.
    now += 1_000;
    writeBeat(now);
    expect((await wd.check()).healthy).toBe(true);
    expect(wd.stats().gaveUp).toBe(false);

    // It dies again inside the window and the window budget still stands — one recovery
    // does not erase the evidence that it keeps crashing. Once the window has passed,
    // the budget is available again.
    now += 1_000;
    writeBeat(now - 10 * 60_000);
    expect((await wd.check()).action).toBe('report');

    now += 61 * 60_000;
    writeBeat(now - 10 * 60_000);
    expect((await wd.check()).action).toBe('restart');
    expect(restarts).toBe(3);
  });

  it('report() delivers the Spanish text to the sink exactly once per call', async () => {
    const now = NOW;
    writeBeat(now - 3 * 60_000);
    const sent: string[] = [];
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      now: () => now,
      lastTurn: () => 'abrió el correo y bajó dos adjuntos',
      restart: () => {},
      onReport: (message) => {
        sent.push(message);
      },
    });

    const verdict = await wd.check();
    const text = await wd.report(verdict);

    expect(sent).toHaveLength(1);
    expect(text).toContain('Asistenta lleva 3 minutos sin responder');
    expect(text).toContain('Lo último que hizo: abrió el correo y bajó dos adjuntos');
    expect(text).toContain('La reinicio');
    expect(text).not.toContain(beat());
  });

  it('reset() clears the budget, for after a human fixed it', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      maxRestarts: 1,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });

    await wd.check();
    expect((await wd.check()).gaveUp).toBe(true);

    wd.reset();
    expect(wd.stats().restartsInWindow).toBe(0);
    expect((await wd.check()).action).toBe('restart');
    expect(restarts).toBe(2);
  });
});

describe('readHeartbeat', () => {
  it('reads the epoch the daemon wrote', () => {
    const at = Date.now();
    writeBeat(at);
    expect(readHeartbeat(beat())).toEqual({ at, source: 'content' });
  });

  it('falls back to the mtime when the content is not a timestamp', () => {
    const file = join(dir, 'agent.heartbeat');
    writeFileSync(file, 'hello');
    const read = readHeartbeat(file);
    expect(read.source).toBe('mtime');
    expect(read.at).not.toBeNull();
  });

  it('a missing heartbeat is missing, not fresh', () => {
    expect(readHeartbeat(join(dir, 'nope.heartbeat'))).toEqual({
      at: null,
      source: 'missing',
    });
  });
});

describe('thresholds and formatting', () => {
  it('the default threshold is three beats with a two-minute floor', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(staleThresholdMs(15_000)).toBe(MIN_STALE_MS);
    expect(staleThresholdMs(60_000)).toBe(180_000);
    // A 1s heartbeat must not make 3s "dead" — that is every GC pause ever.
    expect(staleThresholdMs(1_000)).toBe(MIN_STALE_MS);
  });

  it('durations read in Spanish', () => {
    expect(formatDurationMs(45_000)).toBe('45 segundos');
    expect(formatDurationMs(12 * 60_000)).toBe('12 minutos');
    expect(formatDurationMs(3 * 3_600_000 + 4 * 60_000)).toBe('3 horas y 4 minutos');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('sin latido nunca');
  });
});

describe('runWatchdog', () => {
  it('polls, restarts once, then reports the exhausted budget without repeating it', async () => {
    const now = NOW;
    writeBeat(now - 10 * 60_000);
    const reports: string[] = [];
    let restarts = 0;

    const verdicts = await runWatchdog({
      heartbeatFile: beat(),
      staleAfterMs: 120_000,
      maxRestarts: 1,
      windowMs: 15 * 60_000,
      intervalMs: 100,
      maxChecks: 4,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
      onReport: (message) => {
        reports.push(message);
      },
    });

    expect(verdicts.map((v) => v.action)).toEqual(['restart', 'report', 'report', 'report']);
    expect(restarts).toBe(1);
    // One message per state change, not one per poll: a five-minute outage must not
    // become two hundred Telegram messages.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('dejo de reiniciarla');
  });
});
