import { splitGoalScope } from '../goals/store.js';

/**
 * The conversation an inspection command (/memory and friends) reads. Unlike
 * resolveThread it NEVER creates a thread — a read-only command has no
 * business spawning a conversation — and it never looks at occupancy: the
 * new-request heuristic ("main is busy, start #m<messageId>") is exactly what
 * made /memory answer "No recuerdo nada" with a full memory and litter a new
 * thread per read (auditor #152 ronda 1). Explicit intent wins, in
 * resolveThread's order: /topic, a reply to one of our messages, a real
 * Telegram thread id; without any of them, main is read even while busy.
 */
export function inspectionThreadKey(opts: {
  chatKey: string;
  activeTopic?: string | undefined;
  replyThreadKey?: string | undefined;
  /** Durable reply routing: a goal notification's owning scope, from SQLite. */
  replyGoalScope?: string | undefined;
  threadId?: string | undefined;
}): string {
  if (opts.activeTopic) return `${opts.chatKey}#${opts.activeTopic}`;
  if (opts.replyThreadKey) return opts.replyThreadKey;
  if (opts.replyGoalScope) {
    // Same validation as resolveThread: the notification must belong to THIS
    // chat — a foreign scope is ignored, never followed.
    const { chatKey, thread } = splitGoalScope(opts.replyGoalScope);
    if (chatKey === opts.chatKey) return `${chatKey}#${thread}`;
  }
  if (opts.threadId) return `${opts.chatKey}#t${opts.threadId}`;
  return `${opts.chatKey}#main`;
}
