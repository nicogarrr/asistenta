/** The workstream is a view of the goal, never another source of lifecycle truth. */
import { log } from '../log.js';
import type { Goal } from './store.js';
export interface GoalWorkstreamProjection {
  update(
    id: string,
    fields: { status?: 'active' | 'paused' | 'done'; nextSteps?: string | null },
  ): void;
}
export function projectGoal(goal: Goal, workstreams: GoalWorkstreamProjection): void {
  if (!goal.workstreamId || goal.status === 'proposed' || goal.status === 'cancelled') return;
  const status =
    goal.status === 'blocked' || goal.status === 'paused'
      ? 'paused'
      : goal.status === 'done'
        ? 'done'
        : 'active';
  const next = goal.plan.find((step) => !step.done)?.text ?? 'plan completado';
  const nextSteps =
    goal.status === 'blocked'
      ? `Esperando respuesta del usuario: ${goal.blockedReason ?? 'decisión pendiente'}`
      : goal.status === 'paused'
        ? `Pausado; no ejecutar. Al reanudar: ${next}`
        : next;
  try {
    workstreams.update(goal.workstreamId, { status, nextSteps });
  } catch {
    log.warn('goal workstream projection unavailable', { goal: goal.id });
  }
}
