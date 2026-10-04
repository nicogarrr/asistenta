// Orquestador de UN ciclo. Todo lo que toca el mundo (contenedor, bateria, modelo)
// entra inyectado: aqui solo vive la logica y se prueba sin red.
import { createHash } from 'node:crypto';
import { type CaseResult, scoreRun } from './battery.js';
import { DEFAULT_POLICY, decide, type Policy } from './decide.js';
import { checkPatch } from './guard.js';
import type { Attempt, CycleEntry } from './ledger.js';

export type Deps = {
  /** Elige un tema no descartado y propone un parche (diff) dado el historial de intentos. */
  propose(topic: string, previous: Attempt[]): Promise<{ idea: string; diff: string } | null>;
  /** Mide la bateria en un entorno aislado y limpio. `patch` undefined = linea base (main). */
  measure(patch: string | undefined): Promise<CaseResult[]>;
  now(): Date;
  /** Casos en cuarentena (sitios externos rotos): se excluyen de la puntuacion. */
  quarantined?: () => Set<string>;
};

export async function runCycle(
  topic: string,
  cycleId: string,
  deps: Deps,
  policy: Policy = DEFAULT_POLICY,
): Promise<{ entry: CycleEntry; promotedDiff?: string }> {
  const attempts: Attempt[] = [];
  const startedAt = deps.now().toISOString();
  const done = (outcome: CycleEntry['outcome'], note: string, promotedDiff?: string) => ({
    entry: { cycleId, startedAt, topic, attempts, outcome, note },
    promotedDiff,
  });
  try {
    for (let n = 1; n <= policy.maxIterations + 1; n++) {
      const p = await deps.propose(topic, attempts);
      if (!p) return done('dropped', 'sin ideas nuevas para este tema');
      const a: Attempt = {
        attempt: n,
        idea: p.idea,
        patchSha256: createHash('sha256').update(p.diff).digest('hex'),
      };
      attempts.push(a);
      const bad = checkPatch(p.diff);
      if (bad.length > 0) {
        a.blocked = bad.map((b) => `${b.file}: ${b.rule}`).join('; ');
        a.verdict = {
          action: n > policy.maxIterations ? 'drop' : 'iterate',
          gain: 0,
          reason: 'parche rechazado por el guard',
        };
        continue;
      }
      // La linea base se mide en cada intento, en el mismo entorno que el candidato.
      const q = deps.quarantined?.() ?? new Set<string>();
      const keep = (rs: CaseResult[]) => rs.filter((r) => !q.has(r.caseId));
      const before = scoreRun(keep(await deps.measure(undefined)));
      const after = scoreRun(keep(await deps.measure(p.diff)));
      a.baselineFailing = before.failing;
      a.before = before;
      a.after = after;
      a.verdict = decide(before, after, n, policy);
      if (a.verdict.action === 'promote') {
        return done(
          'promoted',
          'listo para PR y auditoria (FAVORABLE requerido antes de unir)',
          p.diff,
        );
      }
      if (a.verdict.action === 'drop') return done('dropped', a.verdict.reason);
    }
    return done('dropped', 'sin mejora tras los intentos permitidos');
  } catch (e) {
    return done('error', e instanceof Error ? e.message : String(e));
  }
}
