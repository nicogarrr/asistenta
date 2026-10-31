import { describe, expect, it } from 'vitest';
import { checkNames } from '../src/evolve/measure.js';
import { judge, type Measurement } from '../src/evolve/score.js';

// Las sondas de extremo a extremo (evolve/probe-generic-flow.ts) valen más que un test, pero
// un candidato que hace que la sonda se caiga o deje de imprimir un check lo quitaba de
// «checks» y de «checksFailed» a la vez: el juez no veía fallo y, si arreglaba tests en otro
// sitio, lo promovía al kernel.

const run = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 20,
  checks: 10,
  checksFailed: 0,
  durationMs: 60_000,
  passingTests: ['t::a'],
  failingTests: [],
  ...over,
});

describe('juez: regresión en las sondas', () => {
  it('descarta un candidato cuya sonda deja de imprimir los checks, aunque arregle tests', () => {
    // 20 tests arreglados (+40) y 10 checks que ya no salen (-20): antes, «mejora del 25 %».
    const v = judge(run(), run({ passed: 120, failed: 0, checks: 0 }));
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/regresión en las sondas: checks que pasaban 10->0/);
  });

  it('descarta si un check que pasaba ahora falla aunque otro se arregle (mismos totales)', () => {
    const kernel = run({ checks: 2, checksFailed: 1, passingChecks: ['abre', 'rellena'] });
    const cand = run({
      passed: 110,
      failed: 10,
      checks: 2,
      checksFailed: 1,
      passingChecks: ['abre', 'envía'],
    });
    const v = judge(kernel, cand);
    expect(v.kind).toBe('discard');
    expect(v.reason).toContain('rellena');
  });

  it('sigue promoviendo una mejora real que conserva los checks', () => {
    // «envía» fallaba en el kernel (la sonda imprime siempre los mismos checks) y ahora pasa.
    const kernel = run({
      checks: 2,
      checksFailed: 1,
      passingChecks: ['abre', 'rellena'],
      failingChecks: ['envía'],
    });
    const v = judge(
      kernel,
      run({ passed: 120, failed: 0, checks: 3, passingChecks: ['abre', 'rellena', 'envía'] }),
    );
    expect(v.kind).toBe('promote');
  });
});

describe('checkNames', () => {
  it('saca la etiqueta sin el detalle (raya buena o mal codificada) ni colores', () => {
    const out = [
      'PASA  abre la página — 120 ms',
      'FALLA  el campo recibe foco â€” error: timeout',
      '\u001b[32mPASA  envía el formulario\u001b[0m',
      'algo más PASA no cuenta',
    ].join('\n');
    expect(checkNames(out)).toEqual({
      passing: ['abre la página', 'envía el formulario'],
      failing: ['el campo recibe foco'],
    });
  });
});
