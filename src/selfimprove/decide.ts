// Decision de un ciclo: promover, iterar o descartar. Pura y estricta (falla cerrada).
import type { Score } from '../evolve/battery.js';

export type Policy = {
  /** Mejora minima en puntos de la tasa de aprobados (0.05 = 5 puntos). */
  minGain: number;
  /** Intentos extra tras el primero cuando no mejora (Nico: 2-3). */
  maxIterations: number;
};

export const DEFAULT_POLICY: Policy = { minGain: 0.05, maxIterations: 3 };

export type Verdict =
  | { action: 'promote'; gain: number; reason: string }
  | { action: 'iterate'; gain: number; reason: string }
  | { action: 'drop'; gain: number; reason: string };

/**
 * `attempt` empieza en 1. Regla:
 * - Baterias de distinto tamano o casos distintos: no comparable -> drop (no se promueve a ciegas).
 * - Cualquier caso que pasaba y ahora falla = regresion -> nunca se promueve.
 * - Se promueve solo con ganancia >= minGain Y cero regresiones.
 * - Si no, se itera hasta maxIterations intentos extra; luego se descarta.
 */
export function decide(
  before: Score,
  after: Score,
  attempt: number,
  policy: Policy = DEFAULT_POLICY,
): Verdict {
  const ids = (s: Score) => [...s.passing, ...s.failing].sort().join('|');
  if (before.total === 0 || ids(before) !== ids(after)) {
    return {
      action: 'drop',
      gain: 0,
      reason: 'las baterias no son comparables (casos distintos o vacia)',
    };
  }
  const gain = after.rate - before.rate;
  const afterFail = new Set(after.failing);
  const regressions = before.passing.filter((id) => afterFail.has(id));
  const pct = (x: number) => `${(x * 100).toFixed(1)} puntos`;
  const exhausted = attempt > policy.maxIterations;
  const retry = (why: string): Verdict =>
    exhausted
      ? { action: 'drop', gain, reason: `${why}; agotados ${policy.maxIterations + 1} intentos` }
      : { action: 'iterate', gain, reason: why };

  if (regressions.length > 0) {
    return retry(`regresiones en ${regressions.join(', ')} (ganancia ${pct(gain)})`);
  }
  if (gain + 1e-9 < policy.minGain) {
    return retry(`ganancia ${pct(gain)} < umbral ${pct(policy.minGain)}`);
  }
  return { action: 'promote', gain, reason: `ganancia ${pct(gain)} sin regresiones` };
}
