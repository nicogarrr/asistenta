import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import { pickAttempt, reapAttempt, SANDBOX_ENV } from '../src/evolve/reap.js';
import type { Measurement } from '../src/evolve/score.js';

// execFile solo mata al hijo directo: lo que el proponente deja en marcha (en segundo plano,
// con setsid) seguía vivo mientras se medía el intento y podía cambiar la copia o el informe.

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (f: string): Promise<number> => {
  for (let i = 0; i < 200 && !existsSync(f); i++) await new Promise((r) => setTimeout(r, 50));
  return Number(readFileSync(f, 'utf8'));
};
// Un proceso que lanza un nieto separado (setsid), escribe su pid y termina.
const LEAVE = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true, stdio: 'ignore', cwd: process.env.LEFT_CWD, env: process.env.LEFT_ENV === 'none' ? {} : process.env,
});
c.unref();
require('node:fs').writeFileSync(process.env.PID_FILE, String(c.pid));`;

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0)) if (alive(p)) process.kill(p, 'SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function leave(dir: string, env: Record<string, string>): Promise<number> {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'evo-reap-p-')), 'pid');
  dirs.push(join(pidFile, '..'));
  const c = spawn(process.execPath, ['-e', LEAVE], {
    cwd: dir,
    env: { ...process.env, PID_FILE: pidFile, ...env },
    stdio: 'ignore',
  });
  await new Promise((r) => c.on('exit', r));
  const pid = await waitFor(pidFile);
  pids.push(pid);
  return pid;
}

describe.runIf(process.platform === 'linux')('reapAttempt en Linux', () => {
  it('mata al nieto separado que lleva la marca aunque esté en otra carpeta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-reap-'));
    dirs.push(dir);
    const pid = await leave(dir, { [SANDBOX_ENV]: dir, LEFT_CWD: tmpdir() });
    expect(alive(pid)).toBe(true);
    expect(reapAttempt(dir)).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });
  it('mata al que trabaja dentro de la copia aunque borre su entorno', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-reap-'));
    dirs.push(dir);
    const pid = await leave(dir, { LEFT_CWD: dir, LEFT_ENV: 'none' });
    reapAttempt(dir);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  });
  it('no toca procesos ajenos a la copia', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evo-reap-'));
    const other = mkdtempSync(join(tmpdir(), 'evo-reap-o-'));
    dirs.push(dir, other);
    const pid = await leave(other, { LEFT_CWD: other });
    expect(reapAttempt(dir)).toBe(0);
    expect(alive(pid)).toBe(true);
  });
});

describe('pickAttempt', () => {
  it('incluye descendientes y nunca a sí mismo ni a sus antepasados', () => {
    const procs = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1, cwd: '/s/w1' }, // este proceso, trabajando dentro de la copia
      { pid: 20, ppid: 1, marked: true },
      { pid: 21, ppid: 20, cwd: '/tmp' },
      { pid: 22, ppid: 21 },
      { pid: 30, ppid: 1, cwd: '/s/w10' }, // otra copia que empieza igual
    ];
    expect(pickAttempt(procs, '/s/w1', 10, false).sort()).toEqual([20, 21, 22]);
  });
  it('en Windows mira la línea de órdenes, sin distinguir mayúsculas', () => {
    const procs = [
      { pid: 5, ppid: 4, cmd: 'node C:\\State\\Evolve\\W1\\x.js' },
      { pid: 6, ppid: 5, cmd: 'conhost.exe' },
      { pid: 7, ppid: 4, cmd: 'node C:\\otra\\y.js' },
    ];
    expect(pickAttempt(procs, 'c:/state/evolve/w1', 99, true).sort()).toEqual([5, 6]);
  });
});

describe.runIf(process.platform === 'linux')('el bucle cierra lo que deja el proponente', () => {
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd,
      encoding: 'utf8',
    }).trim();
  const m = (over: Partial<Measurement> = {}): Measurement => ({
    passed: 100,
    failed: 1,
    checks: 10,
    checksFailed: 0,
    durationMs: 1000,
    passingTests: ['t::a'],
    failingTests: ['t::b'],
    ...over,
  });

  it('antes de medir el intento ya no queda vivo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evo-reap-r-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-reap-s-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    let left = 0;
    let aliveAtMeasure: boolean | undefined;
    await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
        left = await leave(dir, { LEFT_CWD: dir });
      },
      measure: async (o) => {
        if (o.cwd === root) return m();
        aliveAtMeasure = alive(left);
        return m();
      },
    });
    expect(left).toBeGreaterThan(0);
    expect(aliveAtMeasure).toBe(false);
    expect(alive(left)).toBe(false);
  });
});
