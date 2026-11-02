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
 *
 * Two identical questions at the same moment (two parallel calls for the same purchase,
 * before the first has an answer) are not that sequence: they would be two charges. So
 * the second is never asked and never approved on its own. It waits for the first and
 * comes back denied whatever the answer was (a «no» is shared, a «sí» covers only the
 * purchase it was asked for, an error denies). This can only deny earlier, never allow.
 */
export interface PurchaseApprovals {
  /** Pregunta (o reutiliza la respuesta de este turno) por `action` + `summary` en el hilo. */
  ask(
    threadKey: string,
    action: string,
    summary: string,
    askHuman: (summary: string, signal?: AbortSignal) => Promise<boolean>,
    /** La señal del turno: con el turno cortado (/stop, timeout) la pregunta se retira. */
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Fin del turno del hilo: ninguna respuesta pasa al turno siguiente. */
  forgetThread(threadKey: string): void;
}

/** `askHuman` hace la pregunta de verdad (en el daemon, Telegram sin botones de ámbito). */
export function createPurchaseApprovals(): PurchaseApprovals {
  const answers = new Map<string, boolean>();
  /** La pregunta idéntica que está ahora mismo en el chat, sin respuesta todavía. */
  const inFlight = new Map<string, Promise<boolean>>();
  return {
    async ask(threadKey, action, summary, askHuman, signal) {
      const key = `${threadKey}:${action}:${summary}`;
      // Turno ya cortado (/stop, timeout): denegada, ni se pregunta ni vale un «sí» que
      // se diera antes en este turno (no se abre la pantalla de pago después de /stop).
      if (signal?.aborted) return false;
      const remembered = answers.get(key);
      if (remembered !== undefined) return remembered;
      const pending = inFlight.get(key);
      if (pending) {
        // La misma pregunta ya está en el chat: no se repite y esta nunca se aprueba sola.
        log.info('duplicate purchase approval denied', { thread: threadKey, tool: action });
        await waitSettled(pending, signal);
        return false;
      }
      log.info('approval requested', { thread: threadKey, tool: action });
      const asking = signal ? askHuman(summary, signal) : askHuman(summary);
      inFlight.set(key, asking);
      try {
        const approved = await asking;
        answers.set(key, approved);
        return approved;
      } finally {
        if (inFlight.get(key) === asking) inFlight.delete(key);
      }
    },
    forgetThread(threadKey) {
      for (const key of answers.keys()) {
        if (key.startsWith(`${threadKey}:`)) answers.delete(key);
      }
    },
  };
}

/** Espera a que la primera pregunta se resuelva (o falle), o a que se corte este turno. */
function waitSettled(pending: Promise<boolean>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      signal?.removeEventListener('abort', done);
      resolve();
    };
    signal?.addEventListener('abort', done, { once: true });
    pending.then(done, done);
  });
}
