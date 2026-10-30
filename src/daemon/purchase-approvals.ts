import { log } from '../log.js';

/**
 * La confirmación humana en la que se para una compra (antes dentro de serveCommand en
 * cli.ts; movida tal cual, sin cambio de comportamiento).
 *
 * Two layers ask about the charge on purpose and neither is the other: the gate asks
 * because money always asks, and the tool asks because it is the only layer that
 * knows what is being bought and for how much. A gate that can be misconfigured is
 * not a reason to leave the charge to chance.
 *
 * The consequence is that the same purchase would put two identical questions in the
 * chat, and a prompt you answer twice by reflex is a prompt you stop reading. So the
 * answer is remembered for the turn, keyed by thread and by the exact question: the
 * second layer reuses the first answer rather than asking again. Keyed by question and
 * not by tool, so two different purchases in one turn still ask twice - which is the
 * case where a second question is worth the interruption.
 */
export interface PurchaseApprovals {
  /** Pregunta (o reutiliza la respuesta de este turno) por `action` + `summary` en el hilo. */
  ask(
    threadKey: string,
    action: string,
    summary: string,
    askHuman: (summary: string) => Promise<boolean>,
  ): Promise<boolean>;
  /** Fin del turno del hilo: ninguna respuesta pasa al turno siguiente. */
  forgetThread(threadKey: string): void;
}

/** `askHuman` hace la pregunta de verdad (en el daemon, Telegram sin botones de ámbito). */
export function createPurchaseApprovals(): PurchaseApprovals {
  const answers = new Map<string, boolean>();
  return {
    async ask(threadKey, action, summary, askHuman) {
      const key = `${threadKey}:${action}:${summary}`;
      const remembered = answers.get(key);
      if (remembered !== undefined) return remembered;
      log.info('approval requested', { thread: threadKey, tool: action });
      const approved = await askHuman(summary);
      answers.set(key, approved);
      return approved;
    },
    forgetThread(threadKey) {
      for (const key of answers.keys()) {
        if (key.startsWith(`${threadKey}:`)) answers.delete(key);
      }
    },
  };
}
