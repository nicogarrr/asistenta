import { describe, expect, it } from 'vitest';
import {
  checklistPasses,
  type ReceiptInput,
  verificationChecklist,
} from '../src/evolve/receipt.js';
import type { Measurement } from '../src/evolve/score.js';

// El receipt de /evolucion repite la regla del juez para los checks e2e (#856): un check que
// pasaba en la base y ya no pasa es una regresión aunque el número de fallos no suba.

const m = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 3,
  checksFailed: 0,
  durationMs: 1000,
  passingTests: ['t::a'],
  failingTests: [],
  passingChecks: ['abre la página', 'rellena el formulario', 'la captura devuelve bytes enviables'],
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
const checksLine = (c: Measurement) =>
  verificationChecklist(input(c)).find((it) => it.label.startsWith('Checks e2e'));

describe('receipt: checks e2e por nombre', () => {
  it('un check que pasaba y la sonda ya no imprime no pasa la lista, y se nombra', () => {
    const c = m({ checks: 2, passingChecks: ['abre la página', 'rellena el formulario'] });
    const line = checksLine(c);
    expect(line?.ok).toBe(false);
    expect(line?.detail).toContain('dejan de pasar: la captura devuelve bytes enviables');
    expect(checklistPasses(verificationChecklist(input(c)))).toBe(false);
  });
  it('cambiar un check que pasaba por otro nuevo tampoco pasa (mismo total)', () => {
    const c = m({ passingChecks: ['abre la página', 'rellena el formulario', 'otro check'] });
    expect(checksLine(c)?.ok).toBe(false);
  });
  it('sin nombres, menos checks que pasan no pasa', () => {
    const c = m({ checks: 2, passingChecks: undefined });
    expect(checksLine(c)?.ok).toBe(false);
  });
  it('los mismos checks, o más, siguen pasando la lista', () => {
    expect(checksLine(m())?.ok).toBe(true);
    const more = m({ checks: 4, passingChecks: [...(m().passingChecks ?? []), 'nuevo'] });
    expect(checksLine(more)?.ok).toBe(true);
    expect(checklistPasses(verificationChecklist(input(m({ passed: 110 }))))).toBe(true);
  });
  it('más fallos que en la base sigue sin pasar', () => {
    expect(checksLine(m({ checksFailed: 1 }))?.ok).toBe(false);
  });
});
