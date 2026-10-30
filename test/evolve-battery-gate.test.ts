import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BATTERY_FILE,
  type BatteryGate,
  batteryVerdict,
  gateFromFile,
  measureBattery,
  scorable,
} from '../src/evolve/battery-gate.js';
import type { BatteryCase, Trace } from '../src/evolve/battery-judge.js';
import { runWeek, summarize } from '../src/evolve/loop.js';
import { batteryRunnerFromEnv, describeLast, parseTrace, runEvolution } from '../src/evolve/run.js';
import type { Measurement } from '../src/evolve/score.js';

// Modelo simulado: nunca se llama a un modelo real. Cada caso pasa si la respuesta
// menciona su palabra; el «modelo» del candidato se decide por la carpeta (cwd).
const cases: BatteryCase[] = [
  { id: 'a', prompt: 'p', machine: { mustMention: ['alfa'] } },
  { id: 'b', prompt: 'p', machine: { mustMention: ['beta'] } },
  { id: 'q', prompt: 'p', machine: { mustMention: ['x'] }, judge: 'qa' },
  { id: 'off', prompt: 'p', machine: { mustMention: ['x'] }, enabled: false },
];
const trace = (reply: string): Trace => ({ reply, toolCalls: [], approvalsAsked: 0 });
const gate = (says: (cwd: string) => string): BatteryGate => ({
  cases,
  run: async (_c, cwd) => trace(says(cwd)),
  repeats: 1,
});

describe('batería: medir y aprobar', () => {
  it('solo puntúan los casos activos que juzga la máquina', async () => {
    expect(cases.filter(scorable).map((c) => c.id)).toEqual(['a', 'b']);
    const r = await measureBattery(
      gate(() => 'alfa'),
      '/x',
    );
    expect(r.score.passing).toEqual(['a']);
    expect(r.score.total).toBe(2);
  });

  it('si el ejecutor falla, el caso cuenta como fallo', async () => {
    const g: BatteryGate = {
      cases,
      run: async () => {
        throw new Error('boom');
      },
      repeats: 2,
    };
    expect((await measureBattery(g, '/x')).score.passed).toBe(0);
  });

  it('rechaza si un caso que pasaba deja de pasar, aunque la nota no baje', async () => {
    const before = await measureBattery(
      gate(() => 'alfa'),
      '/x',
    );
    const after = await measureBattery(
      gate(() => 'beta'),
      '/x',
    );
    const v = batteryVerdict(before, after);
    expect(v.ok).toBe(false);
    expect(v.regressions).toEqual(['a']);
    expect(v.reason).toMatch(/rompe casos que pasaban: a/);
  });

  it('rechaza una batería vacía y aprueba sin regresiones', async () => {
    const empty = {
      results: [],
      score: {
        ...(
          await measureBattery(
            gate(() => ''),
            '/x',
          )
        ).score,
        total: 0,
      },
    };
    const base = await measureBattery(
      gate(() => 'alfa'),
      '/x',
    );
    expect(batteryVerdict(base, empty).ok).toBe(false);
    const better = await measureBattery(
      gate(() => 'alfa beta'),
      '/x',
    );
    const v = batteryVerdict(base, better);
    expect(v.ok).toBe(true);
    expect(v.reason).toBe('batería 2/2 (antes 1/2), sin regresiones');
  });

  it('la batería real del repo carga y tiene casos que puntúan', () => {
    const g = gateFromFile(join(process.cwd(), BATTERY_FILE), async () => trace(''));
    expect(g.cases.length).toBeGreaterThanOrEqual(74);
    expect(g.cases.filter(scorable).length).toBeGreaterThan(30);
  });
});

describe('evaluador de la batería por comando (PA_EVOLVE_BATTERY)', () => {
  it('sin comando no hay evaluador', () => {
    expect(batteryRunnerFromEnv({})).toBeNull();
  });
  it('la traza es la última línea JSON y se valida', () => {
    expect(parseTrace('log\n{"reply":"hola","toolCalls":[],"approvalsAsked":0}\n').reply).toBe(
      'hola',
    );
    expect(() => parseTrace('{"reply":1}')).toThrow();
    expect(() => parseTrace('nada')).toThrow();
  });
  it('/evolucion avisa de que falta el evaluador y el ciclo no se lanza', async () => {
    const saved = { p: process.env.PA_EVOLVE_PROPOSER, b: process.env.PA_EVOLVE_BATTERY };
    process.env.PA_EVOLVE_PROPOSER = 'node';
    delete process.env.PA_EVOLVE_BATTERY;
    const st = mkdtempSync(join(tmpdir(), 'evo-bat-st-'));
    try {
      expect(describeLast(st)).toMatch(/falta el evaluador de la batería \(PA_EVOLVE_BATTERY\)/);
      expect((await runEvolution({ stateDir: st })).text).toMatch(/no lanzo el ciclo/);
    } finally {
      if (saved.p === undefined) delete process.env.PA_EVOLVE_PROPOSER;
      else process.env.PA_EVOLVE_PROPOSER = saved.p;
      if (saved.b !== undefined) process.env.PA_EVOLVE_BATTERY = saved.b;
      rmSync(st, { recursive: true, force: true });
    }
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
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

describe('runWeek: un candidato solo se promueve si aprueba la batería', () => {
  let root: string;
  let state: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'evo-bat-repo-'));
    state = mkdtempSync(join(tmpdir(), 'evo-bat-state-'));
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });
  // Los tests del candidato mejoran claramente: solo la batería puede frenarlo.
  const week = (battery?: BatteryGate) =>
    runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['subir a de 1 a 2 para cubrir el caso'],
      propose: async (dir) => writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n'),
      measure: async (o) => (o.cwd === root ? m() : m({ passed: 200 })),
      battery,
    });

  it('sin batería no se promueve nada (falla cerrado)', async () => {
    const r = await week();
    expect(r.promoted).toBe(false);
    expect(r.attempts[0]?.reason).toMatch(/sin batería de evaluación/);
  });

  it('se descarta si rompe un caso que pasaba en el kernel', async () => {
    const r = await week(gate((cwd) => (cwd === root ? 'alfa' : 'beta')));
    expect(r.promoted).toBe(false);
    expect(r.attempts[0]?.verdict).toBe('discard');
    expect(r.attempts[0]?.reason).toMatch(/rompe casos que pasaban: a/);
  });

  it('se promueve si la batería no empeora, y el resumen da la nota', async () => {
    const r = await week(gate(() => 'alfa'));
    expect(r.promoted).toBe(true);
    expect(r.batteryBaseline?.passed).toBe(1);
    expect(r.attempts[0]?.reason).toMatch(/batería 1\/2 \(antes 1\/2\), sin regresiones/);
    expect(summarize(r)).toContain('Batería 1/2.');
  });
});
