import { goalNotifyTarget } from '../goals/notify.js';
import type { Goal } from '../goals/store.js';

/**
 * El envío de los avisos de un objetivo (antes dentro de serveCommand en cli.ts).
 * Movido tal cual: cli.ts y el arnés e2e usan este mismo.
 */
export interface GoalNotifyChannel {
  readonly account: string;
  send(msg: {
    channel: 'telegram';
    account: string;
    chatId: string;
    text: string;
    threadId?: string;
    replyToMessageId?: string;
  }): Promise<string | null | undefined>;
}

export interface GoalNotifyDeps {
  telegram: GoalNotifyChannel;
  /** `<chatKey>:<sentId>` → scope del objetivo: la respuesta de Nico vuelve a ese hilo. */
  messageThread: { set(key: string, scope: string): unknown };
  log: { warn(msg: string, fields: Record<string, unknown>): void };
}

/**
 * Los mensajes de un objetivo van al chat que lo posee, y a ningún otro.
 * Al chat Y al hilo: un tema de foro lleva threadId, una conversación nacida
 * de un mensaje lleva el aviso como respuesta a su primer mensaje, y el id
 * enviado se apunta para que la respuesta de Nico caiga en ese mismo hilo en
 * vez de flotar a #main. Devuelve el id enviado, o null si no salió.
 */
export function createGoalNotifySend(
  deps: GoalNotifyDeps,
): (goal: Goal, text: string) => Promise<string | null> {
  const { telegram, messageThread, log } = deps;
  return async (goal, text) => {
    const target = goalNotifyTarget(goal.scope);
    if (!target) return null;
    try {
      const sentId = await telegram.send({
        channel: 'telegram',
        account: telegram.account,
        chatId: target.chatId,
        text,
        threadId: target.threadId,
        replyToMessageId: target.replyToMessageId,
      });
      if (!sentId) return null;
      // The sent id also lands in goal_notifications (sent_id): reply
      // routing survives a daemon restart emptying messageThread.
      messageThread.set(`${target.chatKey}:${sentId}`, goal.scope);
      return sentId;
    } catch (err) {
      log.warn('goal notify failed', { goal: goal.id, err });
      return null;
    }
  };
}
