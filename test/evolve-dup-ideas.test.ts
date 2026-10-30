import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

// La misma idea apuntada dos veces con /evolucion idea se probaba dos veces la misma semana:
// otra medición entera (y otra batería con el modelo) para una idea ya descartada.

const m = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 5,
  checksFailed: 0,
  durationMs: 60_000,
  passingTests: ['t::a'],
  failingTests: [],
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });

describe('evolución: ideas repetidas', () => {
  it('una idea apuntada dos veces se prueba una sola vez', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evo-d-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-ds-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    let calls = 0;
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea A', 'idea A', 'idea B'],
      propose: async (dir) => {
        calls++;
        writeFileSync(join(dir, 'src', 'a.ts'), `export const a = ${calls + 1};\n`);
      },
      // Una regresión: cada intento se descarta.
      measure: async (o) => (o.cwd === root ? m() : m({ passingTests: [] })),
    });
    expect(report.attempts.map((a) => a.hypothesis)).toEqual(['idea A', 'idea B']);
    expect(calls).toBe(2);
  });
});
