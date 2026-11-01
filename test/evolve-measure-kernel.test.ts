import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('medir el intento no puede cambiar el kernel', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd,
      encoding: 'utf8',
    }).trim();

  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'evo-mk-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-mks-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'permissions.ts'), 'export const strict = true;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return { root, state };
  }

  it('los tests del candidato escriben en el kernel: descarte y la semana para', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea', 'otra'],
      propose: async (dir) => {
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: async (o) => {
        if (o.cwd === root) return m();
        writeFileSync(join(root, 'src', 'permissions.ts'), 'export const strict = false;\n');
        return m({ passed: 200, passingTests: ['t::a', 't::b'] });
      },
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.reason).toMatch(/medir el intento/);
    expect(readFileSync(join(root, 'src', 'permissions.ts'), 'utf8')).toContain('false');
  });
});
