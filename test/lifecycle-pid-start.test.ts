import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNotRunning, processAlive } from '../src/lifecycle.js';
import {
  compareIdentity,
  ownIdentity,
  parseProcStatStart,
  processIdentity,
  sameProcessAsRecorded,
} from '../src/process-identity.js';
import { killIfOurs } from '../src/watchdog.js';

/**
 * A pid file left by a crash can name a pid that another NODE program now
 * holds. #868 only recognised strangers by their executable name, so a reused
 * pid owned by node still blocked the start with «already running». The daemon
 * now records its start identity next to the pid (`agent.pid.start`) and a
 * live node process that provably started at another moment is a stranger:
 * the start proceeds and the stranger is never signalled.
 */
const dir = () => mkdtempSync(join(tmpdir(), 'pa-life-start-'));
const children: Array<{ kill: () => boolean }> = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});
const node = (): string => 'node';

function liveChild(): number {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(c);
  if (!c.pid) throw new Error('no pid');
  return c.pid;
}

describe('assertNotRunning with a pid reused by another node program', () => {
  it('starts when the live node process started at another moment, and leaves it alone', () => {
    const d = dir();
    const pid = liveChild();
    writeFileSync(join(d, 'agent.pid'), String(pid));
    writeFileSync(join(d, 'agent.pid.start'), `${pid} proc:1\n`);
    expect(() =>
      assertNotRunning(d, 'agent', { imageOf: node, identityOf: () => 'proc:999999' }),
    ).not.toThrow();
    expect(existsSync(join(d, 'agent.pid'))).toBe(false);
    expect(existsSync(join(d, 'agent.pid.start'))).toBe(false);
    expect(processAlive(pid)).toBe(true);
  });

  it('a wall-clock identity far from the recorded one is a stranger too', () => {
    const d = dir();
    const pid = liveChild();
    writeFileSync(join(d, 'agent.pid'), String(pid));
    writeFileSync(join(d, 'agent.pid.start'), `${pid} ms:1700000000000\n`);
    expect(() =>
      assertNotRunning(d, 'agent', { imageOf: () => null, identityOf: () => 'ms:1700000600000' }),
    ).not.toThrow();
    expect(processAlive(pid)).toBe(true);
  });

  it('still refuses when the identity matches (the daemon really is running)', () => {
    const d = dir();
    const pid = liveChild();
    writeFileSync(join(d, 'agent.pid'), String(pid));
    writeFileSync(join(d, 'agent.pid.start'), `${pid} proc:42\n`);
    expect(() =>
      assertNotRunning(d, 'agent', { imageOf: node, identityOf: () => 'proc:42' }),
    ).toThrow(/already running/);
    expect(existsSync(join(d, 'agent.pid'))).toBe(true);
  });

  it('still refuses when the identity cannot be told, is missing, or was written for another pid', () => {
    const d = dir();
    const pid = liveChild();
    writeFileSync(join(d, 'agent.pid'), String(pid));
    writeFileSync(join(d, 'agent.pid.start'), `${pid} proc:1\n`);
    expect(() => assertNotRunning(d, 'agent', { imageOf: node, identityOf: () => null })).toThrow(
      /already running/,
    );
    writeFileSync(join(d, 'agent.pid.start'), `${pid + 1} proc:1\n`);
    expect(() =>
      assertNotRunning(d, 'agent', { imageOf: node, identityOf: () => 'proc:2' }),
    ).toThrow(/already running/);
    writeFileSync(join(d, 'agent.pid.start'), `${pid} ms:5\n`);
    expect(() =>
      assertNotRunning(d, 'agent', { imageOf: node, identityOf: () => 'proc:2' }),
    ).toThrow(/already running/);
  });

  it('a leftover start file without a pid file is cleaned', () => {
    const d = dir();
    writeFileSync(join(d, 'agent.pid.start'), '123 proc:1\n');
    assertNotRunning(d, 'agent');
    expect(existsSync(join(d, 'agent.pid.start'))).toBe(false);
  });
});

describe('process identity', () => {
  it('compares tokens: exact for proc, tolerant for wall clock, unknown across schemes', () => {
    expect(compareIdentity('proc:10', 'proc:10')).toBe('same');
    expect(compareIdentity('proc:10', 'proc:11')).toBe('different');
    expect(compareIdentity('ms:1000', 'ms:3000')).toBe('same');
    expect(compareIdentity('ms:1000', 'ms:600000')).toBe('different');
    expect(compareIdentity('ms:1000', 'proc:1000')).toBe('unknown');
    expect(compareIdentity('basura', 'proc:1')).toBe('unknown');
    expect(compareIdentity('proc:1', null)).toBe('unknown');
  });

  it('reads the start ticks even when the command name has spaces and parentheses', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    expect(parseProcStatStart(`77 (node (x) y) ${fields.join(' ')}`)).toBe('22');
    expect(parseProcStatStart('sin paréntesis')).toBeNull();
  });

  it.runIf(process.platform === 'linux')(
    'tells a live process from another one on this box',
    () => {
      const pid = liveChild();
      const id = processIdentity(pid);
      expect(id).toMatch(/^proc:\d+$/);
      expect(processIdentity(pid)).toBe(id);
      expect(ownIdentity()).toBe(processIdentity(process.pid));
      const d = dir();
      writeFileSync(join(d, 'x.start'), `${pid} ${id}\n`);
      expect(sameProcessAsRecorded(join(d, 'x.start'), pid)).toBe('same');
      writeFileSync(join(d, 'x.start'), `${pid} ${ownIdentity()}\n`);
      expect(sameProcessAsRecorded(join(d, 'x.start'), pid)).toBe('different');
    },
  );
});

describe('watchdog default kill', () => {
  it('never kills a pid that the recorded identity proves is another process', () => {
    const d = dir();
    const pidFile = join(d, 'agent.pid');
    writeFileSync(`${pidFile}.start`, '4242 proc:1\n');
    const killed: number[] = [];
    killIfOurs(4242, pidFile, { identityOf: () => 'proc:2', kill: (p) => killed.push(p) });
    expect(killed).toEqual([]);
    killIfOurs(4242, pidFile, { identityOf: () => 'proc:1', kill: (p) => killed.push(p) });
    killIfOurs(4242, pidFile, { identityOf: () => null, kill: (p) => killed.push(p) });
    expect(killed).toEqual([4242, 4242]);
    expect(readFileSync(`${pidFile}.start`, 'utf8')).toBe('4242 proc:1\n');
  });
});
