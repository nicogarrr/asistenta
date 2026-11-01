import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

const m = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 10,
  checksFailed: 0,
  durationMs: 1000,
  passingTests: ['t::a'],
  failingTests: [],
  ...over,
});

describe('un intento que toca su node_modules no se mide', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });

  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'evo-d-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-ds-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'index.js'), 'real');
    return { root, state };
  }
  const better = (root: string) => async (o: { cwd: string }) =>
    o.cwd === root ? m() : m({ passed: 200, passingTests: ['t::a', 't::b'] });

  it.each([
    [
      'cambia una dependencia',
      (d: string) => writeFileSync(join(d, 'node_modules', 'vitest', 'index.js'), 'todo verde'),
    ],
    [
      'añade un fichero',
      (d: string) => writeFileSync(join(d, 'node_modules', 'vitest', 'x.js'), 'x'),
    ],
    [
      'borra una dependencia',
      (d: string) => rmSync(join(d, 'node_modules', 'vitest'), { recursive: true }),
    ],
  ])('%s: descarte con el motivo', async (_n, poison) => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        poison(dir);
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: better(root),
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/node_modules/);
  });

  it('la caché de vitest no cuenta como cambio de dependencias', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        mkdirSync(join(dir, 'node_modules', '.vite', 'vitest'), { recursive: true });
        writeFileSync(join(dir, 'node_modules', '.vite', 'vitest', 'results.json'), '{}');
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: better(root),
    });
    expect(report.attempts[0]?.reason ?? '').not.toMatch(/node_modules/);
  });
});
