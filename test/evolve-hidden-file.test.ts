import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

// Un fichero nuevo creado antes de que vitest recoja los tests y borrado antes de la revisión
// final (un test que pasa, un vitest.workspace.ts) no dejaba rastro: git status limpio y los
// ficheros versionados intactos. Se mide un árbol distinto del revisado.

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
const AFTER = /cambió después de revisarla/;

describe('un fichero que aparece y desaparece durante la medición', () => {
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
    const root = mkdtempSync(join(tmpdir(), 'evo-hf-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-hfs-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'test', 'unit'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'test', 'unit', 'b.test.ts'), "it('b', () => expect(1).toBe(2));\n");
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
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
  const flash = (f: string, text = "it('x', () => {});\n") => {
    writeFileSync(f, text);
    rmSync(f);
  };

  it('un test nuevo en test/ creado y borrado: descarte', async () => {
    const r = await week((dir) => flash(join(dir, 'test', 'extra.test.ts')));
    expect(r.attempts[0]?.reason).toMatch(AFTER);
  });
  it('en una subcarpeta nueva, borrada con él: descarte', async () => {
    const r = await week((dir) => {
      mkdirSync(join(dir, 'test', 'unit', 'x'));
      flash(join(dir, 'test', 'unit', 'x', 'y.test.ts'));
      rmSync(join(dir, 'test', 'unit', 'x'), { recursive: true });
    });
    expect(r.attempts[0]?.reason).toMatch(AFTER);
  });
  it('un vitest.workspace.ts en la raíz creado y borrado: descarte', async () => {
    const r = await week((dir) => flash(join(dir, 'vitest.workspace.ts'), 'export default [];\n'));
    expect(r.attempts[0]?.reason).toMatch(AFTER);
    expect(r.attempts[0]?.reason).toMatch(/vitest\.workspace\.ts/);
  });
  it('la carpeta temporal que crea un test normal en la raíz no cuenta', async () => {
    const r = await week((dir) => {
      const t = mkdtempSync(join(dir, '.tmp-read-cap-'));
      writeFileSync(join(t, 'f.txt'), 'x');
      rmSync(t, { recursive: true });
    });
    expect(r.attempts[0]?.reason).not.toMatch(AFTER);
  });
  it('sin cambios no hay descarte por esto', async () => {
    const r = await week(() => {});
    expect(r.attempts[0]?.reason).not.toMatch(AFTER);
  });
});
