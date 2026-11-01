import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

// El guard revisa el commit del intento, pero se mide el disco de su copia. Un proceso que el
// proponente deja vivo, o el código del intento mientras corren sus tests, podía cambiar un
// test, node_modules o el git de la copia después del guard: se medía otro árbol que el parche.

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
const better = () =>
  m({ passed: 200, failed: 0, passingTests: ['t::a', 't::b'], failingTests: [] });

describe('la copia medida es la revisada', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd,
      encoding: 'utf8',
    }).trim();

  async function week(tamper: (dir: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'evo-sa-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-sas-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test'));
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'test', 'b.test.ts'), "it('b', () => expect(1).toBe(2));\n");
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea', 'otra'],
      propose: async (dir) => {
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: async (o) => {
        if (o.cwd === root) return m();
        tamper(o.cwd);
        return better();
      },
    });
  }
  const AFTER = /cambió después de revisarla/;

  it('un test cambiado durante la medición: descarte y la semana para', async () => {
    const r = await week((dir) =>
      writeFileSync(join(dir, 'test', 'b.test.ts'), "it('b', () => expect(1).toBe(1));\n"),
    );
    expect(r.promoted).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]?.reason).toMatch(AFTER);
  });
  it('un test cambiado y devuelto a su texto durante la medición también', async () => {
    const r = await week((dir) => {
      const f = join(dir, 'test', 'b.test.ts');
      const before = readFileSync(f, 'utf8');
      writeFileSync(f, "it('b', () => expect(1).toBe(1));\n");
      writeFileSync(f, before);
    });
    expect(r.attempts[0]?.reason).toMatch(AFTER);
  });
  it('un commit nuevo en la copia durante la medición también', async () => {
    const r = await week((dir) => {
      writeFileSync(join(dir, 'test', 'b.test.ts'), "it('b', () => expect(1).toBe(1));\n");
      git(dir, 'commit', '-q', '-am', 'x');
    });
    expect(r.attempts[0]?.reason).toMatch(AFTER);
  });
  it('node_modules cambiado durante la medición también', async () => {
    const r = await week((dir) =>
      writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 2;\n'),
    );
    expect(r.attempts[0]?.reason).toMatch(AFTER);
  });
  it('sin cambios durante la medición no se marca', async () => {
    const r = await week(() => {});
    expect(r.attempts[0]?.reason).not.toMatch(AFTER);
  });
});
