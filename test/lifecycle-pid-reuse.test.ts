import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNotRunning,
  isNodeImage,
  parseTasklistImage,
  processAlive,
} from '../src/lifecycle.js';

/**
 * A pid file left behind by a crash or a hard exit can name a pid the OS has
 * since given to an unrelated program (Windows reuses pids quickly). That must
 * not block the next start with «already running»; an unknown image still does,
 * and the foreign process is never signalled.
 */
const dir = () => mkdtempSync(join(tmpdir(), 'pa-life-reuse-'));
const children: Array<{ kill: () => boolean }> = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

describe('assertNotRunning with a reused pid', () => {
  it('starts when the stale pid now belongs to a program that is not node, and leaves it alone', () => {
    const d = dir();
    const imageOf = (): string => 'chrome.exe';
    writeFileSync(join(d, 'agent.pid'), String(process.ppid));
    writeFileSync(join(d, 'agent.pid.stale'), '123 hard-exit\n');
    expect(() => assertNotRunning(d, 'agent', { imageOf })).not.toThrow();
    expect(existsSync(join(d, 'agent.pid'))).toBe(false);
    expect(processAlive(process.ppid)).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')(
    'reads the real image of a live foreign process (sleep)',
    async () => {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      children.push(child);
      await new Promise((r) => setTimeout(r, 100));
      const d = dir();
      writeFileSync(join(d, 'agent.pid'), String(child.pid));
      expect(() => assertNotRunning(d, 'agent')).not.toThrow();
      expect(existsSync(join(d, 'agent.pid'))).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(processAlive(child.pid as number)).toBe(true);
    },
  );

  it('still refuses when the live pid is a node process', () => {
    const d = dir();
    writeFileSync(join(d, 'agent.pid'), String(process.ppid));
    expect(() => assertNotRunning(d, 'agent', { imageOf: () => 'node.exe' })).toThrow(
      /ya está en marcha/,
    );
    expect(existsSync(join(d, 'agent.pid'))).toBe(true);
  });

  it('still refuses when the image cannot be read', () => {
    const d = dir();
    writeFileSync(join(d, 'agent.pid'), String(process.ppid));
    expect(() => assertNotRunning(d, 'agent', { imageOf: () => null })).toThrow(
      /ya está en marcha/,
    );
  });

  it('recognises node images and parses tasklist output', () => {
    expect(isNodeImage('node.exe')).toBe(true);
    expect(isNodeImage('NODE.EXE')).toBe(true);
    expect(isNodeImage('/usr/bin/node')).toBe(true);
    expect(isNodeImage('chrome.exe')).toBe(false);
    expect(isNodeImage('nodepad.exe')).toBe(false);
    expect(isNodeImage('')).toBe(false);
    const out = '"chrome.exe","4242","Console","1","120.000 K"\r\n';
    expect(parseTasklistImage(out, 4242)).toBe('chrome.exe');
    expect(parseTasklistImage(out, 4243)).toBeNull();
    expect(
      parseTasklistImage('INFO: No tasks are running which match the specified criteria.', 4242),
    ).toBeNull();
  });
});
