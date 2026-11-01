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

describe('el proponente no puede cambiar el kernel desde fuera de su sandbox', () => {
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
    const root = mkdtempSync(join(tmpdir(), 'evo-k-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-ks-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'src', 'permissions.ts'), 'export const strict = true;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return { root, state };
  }
  const better = (root: string) => async (o: { cwd: string }) =>
    o.cwd === root ? m() : m({ passed: 200, passingTests: ['t::a', 't::b'] });

  it('escribe en el árbol del kernel: descarte, para la semana y no lo deshace', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 2,
      hypotheses: async () => ['idea', 'otra'],
      propose: async (dir) => {
        writeFileSync(join(root, 'src', 'permissions.ts'), 'export const strict = false;\n');
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: better(root),
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.reason).toMatch(/kernel/);
    // Queda para que una persona lo vea; el bucle no borra trabajo ajeno.
    expect(readFileSync(join(root, 'src', 'permissions.ts'), 'utf8')).toContain('false');
  });

  it('mueve la rama del kernel desde el worktree: descarte', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
        git(dir, 'commit', '-qam', 'colado');
        git(dir, 'update-ref', 'refs/heads/main', 'HEAD');
        git(root, 'reset', '-q', '--hard');
      },
      measure: better(root),
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/kernel/);
  });

  it('un intento normal no se ve afectado', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: better(root),
    });
    expect(report.attempts[0]?.reason ?? '').not.toMatch(/kernel/);
  });
});
