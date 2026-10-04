import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNotRunning } from '../src/lifecycle.js';

describe('assertNotRunning', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'pa-life-'));

  it('reclaims a pid file that names this very process (container PID 1 restart)', () => {
    const d = dir();
    writeFileSync(join(d, 'serve.pid'), String(process.pid));
    expect(() => assertNotRunning(d, 'serve')).not.toThrow();
    expect(existsSync(join(d, 'serve.pid'))).toBe(false);
  });

  it('still refuses when another live process owns the pid file', () => {
    const d = dir();
    writeFileSync(join(d, 'serve.pid'), String(process.ppid));
    expect(() => assertNotRunning(d, 'serve')).toThrow(/already running/);
  });

  it('removes a pid file from a dead process', () => {
    const d = dir();
    writeFileSync(join(d, 'serve.pid'), '2147483646');
    expect(() => assertNotRunning(d, 'serve')).not.toThrow();
    expect(existsSync(join(d, 'serve.pid'))).toBe(false);
  });
});
