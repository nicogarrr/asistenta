/**
 * Cómo pregunta un especialista con efectos (notas, PC, tele, casa) cuando el turno
 * viene del panel web.
 *
 * En Telegram nada cambia: la pregunta va al chat del hilo con «Permitir/Denegar».
 * En un turno del panel, en cambio, Nico está mirando el panel y no Telegram (nada de
 * un turno del panel sale por Telegram, ver panel-chat.ts): la pregunta se registra en
 * el broker de aprobaciones (src/approvals/broker.ts), sale en la tarjeta
 * «Aprobaciones» del panel y solo admite «una vez» o «denegar» (`onceOnly`). Sin
 * respuesta antes de que caduque, o si no se puede registrar, se deniega: un
 * especialista nunca actúa sin que alguien haya dicho que sí a ESA acción.
 */
import type { ApprovalBroker } from '../approvals/broker.js';

/** Lo que el panel enseña como motivo de la tarjeta. */
export const SPECIALIST_PANEL_REASON = 'Lo pide un especialista desde el panel: solo esta acción.';

export interface SpecialistAskDeps {
  /** ¿El turno vivo de este hilo es del panel web? */
  panelTurn: () => boolean;
  /** La pregunta de siempre por el canal (Telegram), sin botones de alcance. */
  viaChannel: (question: string) => Promise<boolean>;
  broker: Pick<ApprovalBroker, 'register' | 'wait'>;
  /** El chat del hilo (para que /stop pueda denegar lo que siga pendiente). */
  chatId?: string;
  /** Caducidad de la pregunta en el panel; por defecto la del broker (5 min). */
  ttlMs?: number;
}

export function createSpecialistAsk(
  deps: SpecialistAskDeps,
): (question: string) => Promise<boolean> {
  return async (question) => {
    if (!deps.panelTurn()) return deps.viaChannel(question);
    try {
      const pending = deps.broker.register({
        tool: 'delegate',
        reason: SPECIALIST_PANEL_REASON,
        question,
        onceOnly: true,
        ...(deps.chatId !== undefined ? { chatId: deps.chatId } : {}),
        ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}),
        // La decisión llega por `wait`; este callback no concede nada por su cuenta.
        resolve: () => {},
      });
      // `wait` sin plazo dura hasta la caducidad y entonces deniega y limpia la entrada.
      return (await deps.broker.wait(pending.id)) === 'once';
    } catch {
      return false;
    }
  };
}

/**
 * /stop y el apagado: lo que un especialista dejó preguntado en el panel se deniega
 * (de un chat, o todo sin `chatId`), igual que `cancelForChat` hace en Telegram. Solo
 * toca las preguntas de especialista (`onceOnly`).
 */
export function denySpecialistAsksForChat(
  broker: Pick<ApprovalBroker, 'list' | 'resolve'>,
  chatId?: string,
): number {
  let denied = 0;
  const pending = chatId === undefined ? broker.list() : broker.list({ chatId });
  for (const approval of pending) {
    if (approval.onceOnly && broker.resolve(approval.id, 'deny')) denied++;
  }
  return denied;
}
