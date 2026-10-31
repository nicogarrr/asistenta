import { describe, expect, it } from 'vitest';
import { judge, type Measurement } from '../src/evolve/score.js';

// La sonda de extremo a extremo carga el código del intento. Ese código podía imprimir sus
// propias líneas «PASA x»: cada una contaba como un check que pasa (+2 en la nota) y el juez lo
// promovía. La sonda está protegida, así que sus checks son los del kernel.

const run = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 2,
  checksFailed: 1,
  durationMs: 60_000,
  passingTests: ['t::a'],
  failingTests: [],
  passingChecks: ['abre', 'rellena'],
  failingChecks: ['envía'],
  ...over,
});

describe('juez: checks que no imprimió la sonda', () => {
  it('checks nuevos impresos por el intento: descarte', () => {
    const extra = Array.from({ length: 20 }, (_, i) => `falso ${i}`);
    const v = judge(run(), run({ checks: 22, passingChecks: ['abre', 'rellena', ...extra] }));
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/no son de la sonda/);
  });
  it('el mismo check repetido: descarte', () => {
    const v = judge(
      run(),
      run({ checks: 12, passingChecks: ['abre', 'rellena', ...Array(10).fill('abre')] }),
    );
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/no son de la sonda/);
  });
  it('un check que pasa y falla a la vez: descarte', () => {
    const v = judge(
      run(),
      run({ checks: 3, passingChecks: ['abre', 'rellena', 'envía'], failingChecks: ['envía'] }),
    );
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/no son de la sonda/);
  });
  it('más líneas «PASA» que checks con nombre: descarte', () => {
    const v = judge(run(), run({ checks: 30 }));
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/no son de la sonda/);
  });
  it('arreglar de verdad un check que fallaba en el kernel sigue contando', () => {
    const v = judge(
      run(),
      run({
        checks: 3,
        checksFailed: 0,
        passingChecks: ['abre', 'rellena', 'envía'],
        failingChecks: [],
      }),
    );
    expect(v.kind).toBe('promote');
  });
});
