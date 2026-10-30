import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Archive } from '../src/evolve/archive.js';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

// Una idea descartada queda como «callejón sin salida» y no se vuelve a probar nunca. Pero
// un descarte que no midió la idea (sin batería configurada, suite que se pasa de tiempo
// con la máquina ocupada) la mataba igual: con el bucle sin batería, CADA idea buena se
// perdía para siempre.

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

const IDEA = 'acortar el prompt del sistema sin perder ninguna instrucción';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
    cwd,
    stdio: 'pipe',
  });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'evo-u-'));
  const state = mkdtempSync(join(tmpdir(), 'evo-us-'));
  dirs.push(root, state);
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, state };
}

const week = (root: string, state: string, cand: Measurement) =>
  runWeek({
    root,
    stateDir: state,
    maxTries: 1,
    hypotheses: async () => [IDEA],
    propose: async (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n'),
    measure: async (o) => (o.cwd === root ? m() : cand),
  });

describe('evolución: un descarte sin medir no mata la idea', () => {
  it('sin batería se descarta, pero la semana siguiente la idea se vuelve a probar', async () => {
    const { root, state } = repo();
    const first = await week(root, state, m({ passed: 200, passingTests: ['t::a', 't::b'] }));
    expect(first.attempts[0]?.reason).toMatch(/sin batería/);
    const second = await week(root, state, m({ passed: 200, passingTests: ['t::a', 't::b'] }));
    expect(second.attempts.map((a) => a.hypothesis)).toEqual([IDEA]);
  });

  it('una medición que falla (tiempo agotado) no la mata a la primera; a la segunda sí', async () => {
    const { root, state } = repo();
    const fallo = m({ error: 'tiempo agotado', passingTests: undefined });
    await week(root, state, fallo);
    expect((await week(root, state, fallo)).attempts).toHaveLength(1);
    expect((await week(root, state, fallo)).attempts).toHaveLength(0);
  });

  it('una regresión de verdad sigue matando la idea a la primera', async () => {
    const { root, state } = repo();
    await week(root, state, m({ passingTests: [] }));
    expect((await week(root, state, m())).attempts).toHaveLength(0);
  });

  it('Archive.deadEnds: dos descartes sin medir = idea muerta; uno solo, no', () => {
    const { state } = repo();
    const a = new Archive(join(state, 'a.jsonl'));
    const row = { week: '2026-W44', kind: 'verdict' as const, verdict: 'discard' as const };
    a.add({ ...row, hypothesis: 'x', unmeasured: true });
    a.add({ ...row, hypothesis: 'y', unmeasured: true });
    a.add({ ...row, hypothesis: 'y', unmeasured: true });
    a.add({ ...row, hypothesis: 'z' });
    expect(a.deadEnds().sort()).toEqual(['y', 'z']);
  });
});
