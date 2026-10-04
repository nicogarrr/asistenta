import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import { cleanEnv, parseJsonReport } from '../src/evolve/measure.js';
import { proposerEnv } from '../src/evolve/run.js';
import { judge, type Measurement, touchesForbidden } from '../src/evolve/score.js';
import { checkPatch } from '../src/selfimprove/guard.js';

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

describe('regresion por test, no por conteo', () => {
  it('arregla 2 y rompe 1: baja el conteo de fallos pero NO se promueve', () => {
    const kernel = m({
      passed: 98,
      failed: 2,
      passingTests: ['t::a', 't::b', 't::c'],
      failingTests: ['t::x', 't::y'],
    });
    const cand = m({
      passed: 99,
      failed: 1,
      passingTests: ['t::x', 't::y', 't::a', 't::b'],
      failingTests: ['t::c'],
    });
    const v = judge(kernel, cand, { minGainPct: 1 });
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/regresión por test/);
  });
  it('un test borrado cuenta como regresion', () => {
    const kernel = m({ passingTests: ['t::a', 't::b'], failingTests: [] });
    const cand = m({ passed: 200, passingTests: ['t::a'], failingTests: [] });
    expect(judge(kernel, cand).kind).toBe('discard');
  });
  it('sin regresiones y con mejora se promueve', () => {
    const kernel = m({ passingTests: ['t::a'], failingTests: [] });
    const cand = m({ passed: 120, passingTests: ['t::a', 't::b'], failingTests: [] });
    expect(judge(kernel, cand, { minGainPct: 5 }).kind).toBe('promote');
  });
  it('lee el informe json de vitest', () => {
    const r = parseJsonReport(
      JSON.stringify({
        testResults: [
          {
            name: '/x/test/a.test.ts',
            assertionResults: [
              { fullName: 'ok', status: 'passed' },
              { fullName: 'mal', status: 'failed' },
              { fullName: 'skip', status: 'pending' },
            ],
          },
        ],
      }),
    );
    expect(r).toEqual({ passing: ['test/a.test.ts::ok'], failing: ['test/a.test.ts::mal'] });
  });
});

describe('fail-closed sin informe por test', () => {
  it('sin informe en el candidato: descarte aunque mejore', () => {
    const cand = m({ passed: 500 });
    cand.passingTests = undefined;
    const v = judge(m(), cand);
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/informe por test/);
  });
  it('sin informe en la base: descarte', () => {
    const kernel = m();
    kernel.passingTests = undefined;
    expect(judge(kernel, m({ passed: 500 })).kind).toBe('discard');
  });
});

describe('aislamiento del entorno', () => {
  it('measure no hereda HOME ni claves: usa un HOME temporal (no impide abrir rutas absolutas)', () => {
    const env = cleanEnv({ PATH: '/bin', HOME: '/home/real', APPDATA: 'C:\\real' }, '/tmp/h');
    expect(env.HOME).toBe('/tmp/h');
    expect(env.USERPROFILE).toBe('/tmp/h');
    expect(String(env.APPDATA)).toContain('/tmp/h');
    expect(String(env.LOCALAPPDATA)).toContain('/tmp/h');
    expect(JSON.stringify(env)).not.toContain('/home/real');
  });
  it('el proponente solo recibe lo que el operador nombra', () => {
    const env = proposerEnv({
      PATH: '/bin',
      HOME: '/home/real',
      OTRA_CLAVE: 'x',
      MODEL_KEY: 'k',
      PA_EVOLVE_PROPOSER_PASS: 'MODEL_KEY',
    });
    expect(env.MODEL_KEY).toBe('k');
    expect(env.OTRA_CLAVE).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });
});

describe('guarda: simbolos y rutas', () => {
  it('cli.ts esta prohibido', () => {
    expect(touchesForbidden(['src/cli.ts'])).toEqual(['src/cli.ts']);
  });
  it.each([
    '+  allow: [...THREAD_ALLOW_TOOLS, "checkout"],',
    '+const BROWSER_FREE_ACTIONS = [..., "pay"];',
    '+  allowPayments: true,',
    '-  fullControl: false,',
  ])('relajar %s se detecta', (line) => {
    const diff = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n${line}\n`;
    expect(checkPatch(diff).length).toBeGreaterThan(0);
  });
});

describe('sandbox', () => {
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
    const root = mkdtempSync(join(tmpdir(), 'evo-h-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-hs-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules\nsecret.local\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'i.js'), 'orig');
    return { root, state };
  }

  it('el candidato no puede escribir en el node_modules del kernel', async () => {
    const { root, state } = repo();
    let isLink = true;
    await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        isLink = lstatSync(join(dir, 'node_modules')).isSymbolicLink();
        writeFileSync(join(dir, 'node_modules', 'pkg', 'i.js'), 'envenenado');
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: async () => m(),
    });
    expect(isLink).toBe(false);
    expect(
      execFileSync('cat', [join(root, 'node_modules', 'pkg', 'i.js')], { encoding: 'utf8' }),
    ).toBe('orig');
  });

  it('un fichero ignorado por git cuenta como violacion', async () => {
    const { root, state } = repo();
    const report = await runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
        writeFileSync(join(dir, 'secret.local'), 'oculto');
      },
      measure: async (o) => (o.cwd === root ? m() : m({ passed: 200 })),
    });
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/ignorado/);
    expect(existsSync(join(root, 'secret.local'))).toBe(false);
  });
});
