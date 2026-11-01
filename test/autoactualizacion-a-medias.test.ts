import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoupdateDeps,
  INTERRUPTED_MESSAGE,
  readAutoupdateState,
  runAutoupdate,
  unlock,
} from '../src/autoupdate.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-medias-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** git/npm/daemon falsos con un HEAD que se mueve de verdad (merge y reset). */
function fake(o: { crashOnBuild?: boolean; lockChanged?: boolean } = {}) {
  let head = OLD;
  let crash = o.crashOnBuild ?? false;
  let state: 'running' | 'stopped' = 'running';
  let t = Date.parse('2026-10-31T08:00:00Z');
  const calls: string[] = [];
  const sent: string[] = [];
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      calls.push(`git ${cmd}`);
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${head}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'merge') head = NEW;
      if (args[0] === 'reset') head = args[2] ?? head;
      if (args[0] === 'diff') return { code: 0, out: o.lockChanged ? 'package-lock.json\n' : '' };
      if (args[0] === 'log') return { code: 0, out: 'fix: algo (#1)\n' };
      return { code: 0, out: '' };
    },
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      // El PC se apaga a mitad de compilar: el proceso muere sin terminar nada.
      if (args[1] === 'build' && crash) {
        crash = false;
        throw new Error('apagado a mitad');
      }
      return { code: 0, out: '' };
    },
    daemonState: () => state,
    busy: () => 'libre',
    stopDaemon: async () => {
      calls.push('stop');
      state = 'stopped';
    },
    startDaemon: async () => {
      calls.push('start');
      state = 'running';
      return true;
    },
    backupDist: () => calls.push('backup'),
    restoreDist: () => calls.push('restore'),
    dropBackup: () => calls.push('drop'),
    notify: async (text) => {
      sent.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  const reboot = () => {
    state = 'running';
  };
  return { deps, calls, sent, head: () => head, reboot };
}

describe('autoactualización cortada a mitad (apagón, suspensión, reinicio)', () => {
  it('la revisión siguiente vuelve a la versión anterior en vez de decir «al día»', async () => {
    const f = fake({ crashOnBuild: true, lockChanged: true });
    await expect(runAutoupdate(dir, f.deps, { env: {} })).rejects.toThrow();
    expect(f.head()).toBe(NEW); // se quedó con el código nuevo y la compilación a medias
    unlock(dir); // tras reiniciar, el candado viejo ya no cuenta
    f.reboot();
    f.calls.length = 0;

    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('revertida');
    expect(f.head()).toBe(OLD);
    const order = f.calls.filter((c) => /^(stop|start|restore|git reset|npm )/.test(c));
    expect(order).toEqual([
      'stop',
      `git reset --keep ${OLD}`,
      'npm ci --no-audit --no-fund',
      'restore',
      'start',
    ]);
    expect(f.sent).toEqual([INTERRUPTED_MESSAGE]);
    expect(f.sent[0]).not.toMatch(/git|npm|commit|dist|HEAD/);
    expect(readAutoupdateState(dir).pending).toBeUndefined();
  });

  it('después de volver atrás, la siguiente revisión actualiza normal', async () => {
    const f = fake({ crashOnBuild: true });
    await expect(runAutoupdate(dir, f.deps, { env: {} })).rejects.toThrow();
    unlock(dir);
    await runAutoupdate(dir, f.deps, { env: {} });
    f.sent.length = 0;
    const out = await runAutoupdate(dir, f.deps, { env: {}, force: true });
    expect(out.kind).toBe('actualizada');
    expect(f.head()).toBe(NEW);
    expect(f.sent[0]).toMatch(/^🆕 Me he actualizado/);
    expect(readAutoupdateState(dir).pending).toBeUndefined();
  });

  it('una actualización que acaba bien no deja nada pendiente', async () => {
    const f = fake();
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    expect(readAutoupdateState(dir).pending).toBeUndefined();
  });
});
