import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { markStoppedOnPurpose, STOPPED_ON_PURPOSE_FILE } from '../src/autostart-watchdog.js';
import { DaemonNotRunningError, stopDaemon } from '../src/daemon-control.js';
import { NOT_RUNNING_TEXT, runStopCommand } from '../src/stop-command.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stop-nr-'));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}
function run(dir: string, stop: () => Promise<{ instanceId: string }>) {
  const out: string[] = [];
  const err: string[] = [];
  return runStopCommand({
    stop,
    markStopped: () => markStoppedOnPurpose(dir),
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
  }).then((code) => ({ code, out: out.join(''), err: err.join('') }));
}
const marker = (dir: string) => existsSync(join(dir, STOPPED_ON_PURPOSE_FILE));
const unix = process.platform === 'linux' ? it : it.skip;

describe('pa stop when Asistenta is not running', () => {
  unix(
    'stopDaemon on a state dir with no daemon says «not running», not a raw ENOENT',
    async () => {
      await expect(stopDaemon(stateDir(), 500)).rejects.toBeInstanceOf(DaemonNotRunningError);
    },
  );

  unix(
    'the real CLI path: clear Spanish message, exit 0, and the watchdog keeps it off',
    async () => {
      const dir = stateDir();
      const r = await run(dir, () => stopDaemon(dir, 500));
      expect(r.code).toBe(0);
      expect(r.out).toBe(NOT_RUNNING_TEXT);
      expect(r.out).toContain('no estaba en marcha');
      expect(r.err).toBe('');
      expect(r.out).not.toMatch(/ENOENT|lstat|ready\.json/);
      expect(marker(dir)).toBe(true);
    },
  );

  it('a real failure says so in Spanish, exits 1 and writes no «parado a propósito» mark', async () => {
    const dir = stateDir();
    const r = await run(dir, async () => {
      throw new Error('Control ocupado o flock no disponible; no se ha detenido ningún proceso.');
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('No he podido parar Asistenta: Control ocupado');
    expect(r.err).toContain('No he marcado nada');
    expect(r.out).toBe('');
    expect(marker(dir)).toBe(false);
  });

  it('a confirmed stop keeps its message and writes the mark', async () => {
    const dir = stateDir();
    const r = await run(dir, async () => ({ instanceId: 'abcdef0123456789abcd' }));
    expect(r.code).toBe(0);
    expect(r.out).toBe('Instancia abcdef012345 detenida con cierre limpio confirmado.\n');
    expect(marker(dir)).toBe(true);
  });
});
