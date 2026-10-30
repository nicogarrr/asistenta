import { describe, expect, it } from 'vitest';
import {
  checklistPasses,
  type ReceiptInput,
  verificationChecklist,
} from '../src/evolve/receipt.js';
import type { Measurement } from '../src/evolve/score.js';

// El receipt de /evolucion repite la regla del juez para los tests: un test que pasaba en la
// base y ya no pasa es una regresión aunque el número de fallos no suba (mismo arreglo que #909
// para los checks e2e). Sin informe por test el juez descarta, y el receipt no puede dar ✓.

const m = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 3,
  failed: 1,
  checks: 1,
  checksFailed: 0,
  durationMs: 1000,
  passingTests: ['t::a', 't::b', 't::c'],
  failingTests: ['t::d'],
  passingChecks: ['abre la página'],
  ...over,
});
const input = (candidate: Measurement): ReceiptInput => ({
  week: '2026-W44',
  hypothesis: 'cachear el índice de skills entre turnos',
  attempt: 1,
  kernel: 'abc123',
  branch: 'evolve/w1',
  touched: ['src/a.ts'],
  forbidden: [],
  baseline: m(),
  candidate,
  verdictReason: 'mejora',
  delta: 10,
  minGainPct: 5,
});
const testsLine = (c: Measurement) =>
  verificationChecklist(input(c)).find((it) => it.label.startsWith('Tests'));

describe('receipt: tests por nombre', () => {
  it('arreglar uno y romper otro (mismos fallos) no pasa la lista, y se nombra el roto', () => {
    const c = m({ passingTests: ['t::a', 't::b', 't::d'], failingTests: ['t::c'] });
    const line = testsLine(c);
    expect(line?.ok).toBe(false);
    expect(line?.detail).toContain('dejan de pasar: t::c');
    expect(checklistPasses(verificationChecklist(input(c)))).toBe(false);
  });
  it('un test que pasaba y desaparece del informe tampoco pasa', () => {
    const c = m({ passed: 2, passingTests: ['t::a', 't::b'] });
    expect(testsLine(c)?.ok).toBe(false);
  });
  it('sin informe por test en el candidato no pasa (el juez lo descarta)', () => {
    const c = m({ passingTests: undefined });
    const line = testsLine(c);
    expect(line?.ok).toBe(false);
    expect(line?.detail).toContain('sin informe por test');
  });
  it('los mismos tests, o más, siguen pasando la lista', () => {
    expect(testsLine(m())?.ok).toBe(true);
    const fixed = m({
      passed: 4,
      failed: 0,
      passingTests: ['t::a', 't::b', 't::c', 't::d'],
      failingTests: [],
    });
    expect(testsLine(fixed)?.ok).toBe(true);
  });
  it('más fallos que en la base sigue sin pasar', () => {
    const c = m({ failed: 2, failingTests: ['t::d', 't::e'] });
    expect(testsLine(c)?.ok).toBe(false);
  });
});
