import { isProtectedPath } from './guard.js';

/**
 * Deciding whether a change is an improvement.
 *
 * This is the load-bearing part of the self-improvement loop. Everything else in
 * `src/evolve` can be sloppy as long as this file is not, because this is the only thing
 * standing between a plausible-looking edit and the kernel.
 *
 * The rule, from the Darwin Godel Machine: an attempt is kept only when it measurably
 * beats what came before it. Two things follow from that and both are load-bearing:
 *
 * - The score must be comparable across runs. A number that moves because the machine was
 *   busier is not a measurement, so a run that cannot be compared is rejected rather than
 *   treated as neutral.
 * - A regression is worse than no change. The agent keeps working without the loop, so an
 *   attempt that scores below the kernel is never promoted, no matter how promising the
 *   diff looks.
 */

/** What one measured run produced. */
export interface Measurement {
  /** Tests that passed. */
  passed: number;
  /** Tests that failed. A failed test is a regression, not a neutral. */
  failed: number;
  /** End-to-end checks that passed, from the offline probes. */
  checks: number;
  /** End-to-end checks that failed. */
  checksFailed: number;
  /** Wall-clock of the run. Used only to detect a machine that was too busy to measure. */
  durationMs: number;
  /** Keys of the tests that passed / failed, when the runner reported them per test. */
  passingTests?: string[];
  failingTests?: string[];
  /** Labels of the end-to-end checks that passed, when the probe printed them. */
  passingChecks?: string[];
  /** Labels of the end-to-end checks that failed. */
  failingChecks?: string[];
  /** Set when the run could not produce a number at all. */
  error?: string;
}

/** A score is comparable with another one, or it is not a measurement. */
export interface Score {
  passed: number;
  failed: number;
  checks: number;
  checksFailed: number;
  durationMs: number;
}

/** The one number the loop optimises. Higher is better. */
export function scoreOf(m: Measurement): number {
  // A failed check costs more than a failed test: the end-to-end probes are the ones
  // that describe what the user actually asked for, and a suite that is green while the
  // browser flow is broken is exactly the failure this project keeps fighting.
  return m.passed + m.checks * 2 - m.failed - m.checksFailed * 5;
}

/**
 * Whether two runs can be compared at all.
 *
 * A run that errored has no score. A run that took an absurdly long time was competing
 * with something else for the machine, and its numbers describe that competition rather
 * than the code. Both are rejected instead of being read as "no change".
 */
export function comparable(a: Measurement, b: Measurement, ceilingMs = 15 * 60_000): boolean {
  if (a.error || b.error) return false;
  if (a.durationMs <= 0 || b.durationMs <= 0) return false;
  if (a.durationMs > ceilingMs || b.durationMs > ceilingMs) return false;
  // Both sides must have run something. Zero tests and zero checks means the command
  // silently did nothing, which otherwise reads as a catastrophic score.
  return a.passed + a.checks > 0 && b.passed + b.checks > 0;
}

export type Verdict =
  | { kind: 'promote'; delta: number; reason: string }
  | { kind: 'retry'; delta: number; reason: string }
  | { kind: 'discard'; delta: number; reason: string };

/**
 * Judge one attempt against the kernel it was measured from.
 *
 * `minGain` is the percentage the improvement has to reach before the change goes into
 * the kernel. Anything smaller is not noise-proof and gets another attempt; anything
 * worse is discarded, because a self-improving loop that can also degrade is a loop that
 * eventually destroys the thing it is improving.
 */
export function judge(
  kernel: Measurement,
  candidate: Measurement,
  opts: { minGainPct?: number } = {},
): Verdict {
  const minGainPct = opts.minGainPct ?? 1;
  if (!comparable(kernel, candidate)) {
    const why = candidate.error
      ? `la medición del candidato falló: ${candidate.error}`
      : 'las dos mediciones no son comparables';
    return { kind: 'discard', delta: 0, reason: why };
  }
  const base = scoreOf(kernel);
  const after = scoreOf(candidate);
  const delta = after - base;
  const pct = base === 0 ? (after > 0 ? 100 : 0) : (delta / Math.abs(base)) * 100;

  // Regression PER TEST, not by count: a change that fixes two tests and breaks one lowers
  // the failure count and would otherwise pass. A test that passed before and does not pass
  // now (failed, or vanished) is a regression whatever the totals say.
  if (!kernel.passingTests || !candidate.passingTests) {
    return {
      kind: 'discard',
      delta,
      reason: 'falta el informe por test en la base o en el candidato: no comparable, se descarta',
    };
  }
  {
    const now = new Set(candidate.passingTests);
    const lost = kernel.passingTests.filter((t) => !now.has(t));
    if (lost.length) {
      return {
        kind: 'discard',
        delta,
        reason: `regresión por test: ${lost.length} test(s) que pasaban ya no pasan (${lost.slice(0, 3).join('; ')}). No entra al kernel.`,
      };
    }
  }
  // The same per check: a probe that crashes, or stops printing a check, drops it from
  // both «checks» and «checksFailed», so the failure count does not see it and the lost
  // points can be outweighed by tests fixed elsewhere. A check that passed and no longer
  // passes is a regression; without names, fewer passing checks is one.
  {
    const lostChecks =
      kernel.passingChecks && candidate.passingChecks
        ? (() => {
            const now = new Set(candidate.passingChecks);
            return kernel.passingChecks.filter((c) => !now.has(c));
          })()
        : [];
    if (lostChecks.length || candidate.checks < kernel.checks) {
      const detail = lostChecks.length ? ` (${lostChecks.slice(0, 3).join('; ')})` : '';
      return {
        kind: 'discard',
        delta,
        reason: `regresión en las sondas: checks que pasaban ${kernel.checks}->${candidate.checks}${detail}. No entra al kernel.`,
      };
    }
  }
  {
    // La sonda carga el código del intento, que puede imprimir sus propias líneas «PASA x»:
    // cada una sumaba un check (+2). La sonda está protegida, así que sus checks son los del
    // kernel: uno nuevo, repetido o que pasa y falla a la vez no lo imprimió la sonda.
    const forged =
      kernel.passingChecks && candidate.passingChecks
        ? (() => {
            const known = new Set([...kernel.passingChecks, ...(kernel.failingChecks ?? [])]);
            const seen = new Set<string>();
            const failing = new Set(candidate.failingChecks ?? []);
            const bad = candidate.passingChecks.filter((c) => {
              const dup = seen.has(c);
              seen.add(c);
              return dup || !known.has(c) || failing.has(c);
            });
            if (candidate.checks > candidate.passingChecks.length) bad.push('(cuenta)');
            return bad;
          })()
        : [];
    if (forged.length) {
      return {
        kind: 'discard',
        delta,
        reason: `la sonda del candidato imprimió checks que no son de la sonda (${forged.slice(0, 3).join('; ')}). No entra al kernel.`,
      };
    }
  }
  // Todo check que la versión actual imprime (pase o falle) tiene que salir también en la
  // salida del intento. Uno que fallaba y desaparece restaba un fallo de «checksFailed» y
  // sumaba puntos: un check que se esfuma es un descarte, no una mejora.
  if (kernel.passingChecks) {
    const seen = new Set([...(candidate.passingChecks ?? []), ...(candidate.failingChecks ?? [])]);
    const gone = [...kernel.passingChecks, ...(kernel.failingChecks ?? [])].filter(
      (c) => !seen.has(c),
    );
    if (gone.length) {
      return {
        kind: 'discard',
        delta,
        reason: `faltan checks de la sonda en la salida del candidato (${gone.slice(0, 3).join('; ')}). No entra al kernel.`,
      };
    }
  }
  if (candidate.failed > kernel.failed || candidate.checksFailed > kernel.checksFailed) {
    return {
      kind: 'discard',
      delta,
      reason:
        `el candidato Rompió algo: fallos ${kernel.failed}->${candidate.failed}, ` +
        `checks ${kernel.checksFailed}->${candidate.checksFailed}. Una regresión no entra al kernel.`,
    };
  }
  if (pct >= minGainPct) {
    return {
      kind: 'promote',
      delta,
      reason: `mejora del ${pct.toFixed(2)}% (${base} -> ${after}), por encima del ${minGainPct}% pedido.`,
    };
  }
  if (pct > 0) {
    return {
      kind: 'retry',
      delta,
      reason: `mejora solo del ${pct.toFixed(2)}%, por debajo del ${minGainPct}%. Otro intento con otro enfoque.`,
    };
  }
  return {
    kind: 'discard',
    delta,
    reason: `sin mejora (${base} -> ${after}). Se descarta para no bloquear el bucle.`,
  };
}

/**
 * Files an attempt may never touch, whatever the measured gain says.
 *
 * The loop rewrites the agent's own prompt and tools, so it is editing the thing that
 * decides what it is allowed to do. A change that widens its own permissions, moves money,
 * or reads the vault is not an improvement even if every test passes, so it is refused
 * before it is ever measured. This is the one place where the loop is not allowed to
 * argue with itself.
 */

export function touchesForbidden(files: readonly string[]): string[] {
  return files.filter(isProtectedPath);
}
