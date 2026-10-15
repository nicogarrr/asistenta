import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNotRunning, processAlive } from '../src/lifecycle.js';

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

/**
 * Windows reports EPERM for a pid that no longer exists, so EPERM must not be
 * read as "alive" there or a corpse blocks the next boot. Unix keeps EPERM as a
 * true positive.
 */
describe('processAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function killThrows(code: string) {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
  }

  it('is true when the pid can be signalled', () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it('reads EPERM as alive on unix and as dead on windows', () => {
    killThrows('EPERM');
    expect(processAlive(4321)).toBe(process.platform !== 'win32');
  });

  it('reads ESRCH as dead everywhere', () => {
    killThrows('ESRCH');
    expect(processAlive(4321)).toBe(false);
  });

  it('lets a pid file behind a corpse-boot through', () => {
    const d = mkdtempSync(join(tmpdir(), 'pa-life-'));
    killThrows('EPERM');
    writeFileSync(join(d, 'serve.pid'), '4321');
    if (process.platform === 'win32') {
      expect(() => assertNotRunning(d, 'serve')).not.toThrow();
      expect(existsSync(join(d, 'serve.pid'))).toBe(false);
    } else {
      expect(() => assertNotRunning(d, 'serve')).toThrow(/already running/);
    }
  });
});
