import { type GoalStore, splitGoalScope } from '../goals/store.js';

/** The panel belongs to the configured owner, not every conversation in the DB. */
export function ownerGoals(
  store: Pick<GoalStore, 'list'>,
  ownerId: string | number | null | undefined,
) {
  if (ownerId == null || !/^\d+$/.test(String(ownerId))) {
    throw new Error('Propietario del panel no configurado');
  }
  const ownerChat = `telegram:dm:${ownerId}`;
  return store
    .list()
    .filter((goal) => splitGoalScope(goal.scope).chatKey === ownerChat)
    .map((goal) => {
      const { thread } = splitGoalScope(goal.scope);
      return {
        id: goal.id,
        scope: goal.scope,
        thread,
        title: goal.title,
        status: goal.status,
        plan: goal.plan.map((step) => ({ text: step.text, done: step.done })),
        blockedReason: goal.blockedReason,
        lastOutcome: goal.lastOutcome,
        updatedAt: goal.updatedAt,
        panelChatAvailable: thread === 'main',
      };
    });
}
