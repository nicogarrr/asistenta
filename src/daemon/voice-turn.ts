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
