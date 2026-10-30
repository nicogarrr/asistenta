/**
 * Lo que se dice en voz alta durante una conversación por voz entra como un `Inbound`
 * más (mismo hilo, misma cola, mismo Gate que Telegram). Sacado de cli.ts tal cual
 * (sin cambio de comportamiento) como paso hacia la voz como canal (ARCHITECTURE §5).
 *
 * Va con `channel: 'telegram'` y el chat del propietario a propósito: las aprobaciones
 * que pida el turno se siguen preguntando con botones en ese chat y nada dicho en voz
 * alta cuenta como un «sí».
 */
import type { Inbound } from '../channels/types.js';

export const VOICE_PREFIX = '[dicho en voz alta ante el microfono]';

export function voiceInbound(
  account: string,
  chat: { chatId: Inbound['chatId']; threadId?: Inbound['threadId'] },
  heard: string,
  n: number,
  now: Date = new Date(),
): Inbound {
  return {
    channel: 'telegram',
    account,
    chatId: chat.chatId,
    threadId: chat.threadId,
    userId: String(chat.chatId),
    displayName: 'conversación por voz',
    text: `${VOICE_PREFIX} ${heard}`,
    authorised: true,
    messageId: `voz-${n}`,
    receivedAt: now.toISOString(),
  };
}

/** Lo que necesita un turno de voz del daemon (inyectado desde cli.ts). */
export interface VoiceTurnDeps<T extends { key: string }> {
  account: string;
  /** Número de la siguiente frase oída (para el id del mensaje). */
  nextN(): number;
  getThread(chatKey: string): Promise<T>;
  /** Enlaza el id del mensaje con su hilo (para «dime más» y respuestas citadas). */
  linkMessage(dedupKey: string, threadKey: string): void;
  logUtterance(fields: { chars: number; chatId: string }): void;
  enqueue(thread: T, work: () => Promise<void>): Promise<unknown>;
  runTurn(
    thread: T,
    inbound: Inbound,
    text: string,
    opts: { spoken: (answer: string) => Promise<void> },
  ): Promise<void>;
  /** Dice la respuesta en voz alta en la conversación abierta. */
  speak(answer: string): Promise<void>;
}

/**
 * Una frase oída en la conversación por voz → un turno normal en el hilo principal.
 *
 * Pasa por runTurn como cualquier mensaje: mismo Gate, misma cola. Una aprobación que
 * haga falta se sigue pidiendo con botones de Telegram; nada dicho en voz alta cuenta
 * como un «sí». Encolado en el hilo: la voz no puede solaparse con un turno vivo.
 */
export async function voiceUtteranceTurn<T extends { key: string }>(
  chat: { key: string; chatId: Inbound['chatId']; threadId?: Inbound['threadId'] },
  heard: string,
  deps: VoiceTurnDeps<T>,
): Promise<void> {
  const inbound = voiceInbound(deps.account, chat, heard, deps.nextN());
  const thread = await deps.getThread(chat.key);
  deps.linkMessage(`${chat.key}:${inbound.messageId}`, thread.key);
  deps.logUtterance({ chars: heard.length, chatId: chat.chatId });
  await deps.enqueue(thread, () =>
    deps.runTurn(thread, inbound, inbound.text, { spoken: (answer) => deps.speak(answer) }),
  );
}
