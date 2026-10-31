import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Los hooks y la config de git son del repo entero: lo que el proponente plante ahí sigue
// ejecutándose en el PC de Nico cuando el bucle ya terminó.
describe('el proponente no puede plantar hooks ni config de git en el kernel', () => {
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
    const root = mkdtempSync(join(tmpdir(), 'evo-g-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-gs-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return { root, state };
  }
  const run = (root: string, state: string, plant: (dir: string) => void) =>
    runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        plant(dir);
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: async (o) =>
        o.cwd === root ? m() : m({ passed: 200, passingTests: ['t::a', 't::b'] }),
    });

  it('un hook nuevo: descarte', async () => {
    const { root, state } = repo();
    const report = await run(root, state, () => {
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho hola\n');
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/hooks de git/);
  });

  it('config de git cambiada desde el worktree: descarte', async () => {
    const { root, state } = repo();
    const report = await run(root, state, (dir) => {
      git(dir, 'config', 'core.hooksPath', join(dir, 'h'));
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/config o los hooks/);
  });

  it('sin tocar .git el intento sigue su camino', async () => {
    const { root, state } = repo();
    const report = await run(root, state, () => {});
    expect(report.attempts[0]?.reason ?? '').not.toMatch(/git del kernel/);
    expect(existsSync(join(root, '.git'))).toBe(true);
  });
});
