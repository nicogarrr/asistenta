import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type AutoupdateDeps, runAutoupdate } from '../src/autoupdate.js';

/** Asistenta bajada con «Download ZIP» (sin .git) o sin git instalado. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-sin-git-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(gitOut: string, calls: string[]): AutoupdateDeps {
  const stop = (name: string) => async () => {
    calls.push(name);
    throw new Error(`no debería llamar a ${name}`);
  };
  return {
    git: async (args) => {
      calls.push(`git ${args.join(' ')}`);
      return { code: 128, out: gitOut };
    },
    npm: stop('npm'),
    daemonState: () => 'running',
    busy: () => 'libre',
    stopDaemon: stop('stop'),
    startDaemon: stop('start'),
    backupDist: () => calls.push('backup'),
    restoreDist: () => calls.push('restore'),
    dropBackup: () => calls.push('drop'),
    notify: stop('notify'),
    sleep: async () => {},
    now: () => Date.parse('2026-10-31T06:00:00Z'),
  } as AutoupdateDeps;
}

it.each([
  'fatal: not a git repository (or any of the parent directories): .git',
  'spawn git ENOENT',
])('sin git: lo dice claro en castellano y no toca nada (%s)', async (gitOut) => {
  const calls: string[] = [];
  const out = await runAutoupdate(dir, deps(gitOut, calls), { env: {} });
  expect(out.kind).toBe('omitida');
  expect(out.text).toMatch(/ZIP/);
  expect(out.text).toMatch(/git/);
  expect(out.text).not.toMatch(/rama|«\?»|fatal|ENOENT/);
  expect(calls).toEqual(['git rev-parse --abbrev-ref HEAD']);
});
