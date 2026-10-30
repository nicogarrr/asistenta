import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Archive } from '../src/evolve/archive.js';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

// Si el proponente (el modelo) lanzaba un error, la semana entera se caía: no quedaba
// veredicto archivado (solo la hipótesis) y /evolucion acababa en una excepción.

const m = (): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 5,
  checksFailed: 0,
  durationMs: 60_000,
  passingTests: ['t::a'],
  failingTests: [],
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'evo-p-'));
  const state = mkdtempSync(join(tmpdir(), 'evo-ps-'));
  dirs.push(root, state);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, state };
}

describe('evolución: un fallo del proponente no tumba la semana', () => {
  it('archiva un veredicto, para la semana limpia y no mata la idea', async () => {
    const { root, state } = repo();
    let calls = 0;
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 2,
      hypotheses: async () => ['idea uno', 'idea dos'],
      propose: async () => {
        calls++;
        throw new Error('modelo no disponible');
      },
      measure: async () => m(),
    });
    expect(calls).toBe(1);
    expect(report.promoted).toBe(false);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.reason).toMatch(/proponente falló: modelo no disponible/);
    const archive = new Archive(join(state, 'evolve', 'attempts.jsonl'));
    const verdicts = archive.read().filter((a) => a.kind === 'verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.unmeasured).toBe(true);
    expect(archive.deadEnds()).not.toContain('idea uno');
    // El árbol de trabajo vuelve limpio: la semana siguiente puede medir la base.
    expect(git(root, 'status', '--porcelain').toString()).toBe('');
  });
});
