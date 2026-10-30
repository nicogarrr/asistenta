import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Archive } from '../src/evolve/archive.js';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

// Si no se podía crear el sandbox del intento, la hipótesis quedaba archivada sin veredicto
// y el bucle pasaba a la siguiente idea (que volvía a fallar igual).

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
  const root = mkdtempSync(join(tmpdir(), 'evo-sb-'));
  const state = mkdtempSync(join(tmpdir(), 'evo-sbs-'));
  dirs.push(root, state);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, state };
}

describe('evolución: un fallo al crear el sandbox no deja la idea sin veredicto', () => {
  it('archiva un veredicto sin medir, para la semana y no mata la idea', async () => {
    const { root, state } = repo();
    // Ramas ya ocupadas: createSandbox se niega a reutilizarlas y lanza.
    for (let i = 1; i <= 6; i++) git(root, 'branch', `evolve/${i}`);
    let calls = 0;
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 2,
      hypotheses: async () => ['idea uno', 'idea dos'],
      propose: async () => {
        calls++;
      },
      measure: async () => m(),
    });
    expect(calls).toBe(0);
    expect(report.promoted).toBe(false);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.reason).toMatch(
      /no se pudo aislar el intento: la rama evolve\/\d+ ya existe/,
    );
    const archive = new Archive(join(state, 'evolve', 'attempts.jsonl'));
    const rows = archive.read();
    expect(rows.filter((a) => a.kind === 'hypothesis')).toHaveLength(1);
    const verdicts = rows.filter((a) => a.kind === 'verdict');
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.hypothesis).toBe('idea uno');
    expect(verdicts[0]?.unmeasured).toBe(true);
    expect(archive.deadEnds()).not.toContain('idea uno');
    expect(git(root, 'status', '--porcelain').toString()).toBe('');
  });
});
