/**
 * Goal notifications: the "te habla solo si hay novedad o decisión" half of
 * long-haul goals. Same discipline as the vigilante, for the same reasons:
 *
 * 1. Each finding is notified ONCE. The key is stable (kind + normalised
 *    reason), so a milestone re-detected on the next tick is a duplicate, not
 *    a second message.
 * 2. A failed send is retried, not forgotten: only a confirmed delivery marks
 *    the row. Pending rows are re-attempted on every tick and dropped after a
 *    day, so a blocked chat cannot be spammed forever.
 * 3. The message never promises more than the source: the reason is what the
 *    tick reported, verbatim.
 *
 * The destination is the caller's business (the owning chat's DM), wired as
 * `send` - this module never sees a transport.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type Goal, splitGoalScope } from './store.js';

/** Pending rows older than this are dropped: a chat unreachable for a day stays unreachable. */
export const NOTIFY_RETRY_MAX_AGE_MS = 24 * 60 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goal_notifications (
  goal_id     TEXT NOT NULL,
  nkey        TEXT NOT NULL,
  text        TEXT NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (goal_id, nkey)
);
`;

export type NotifyOutcome = 'sent' | 'pending' | 'duplicate';

/** Stable per (kind, reason): the same milestone found twice has the same key. */
export function notifyKey(kind: string, reason: string): string {
  // The WHOLE normalised reason goes into the hash. Truncating before hashing
  // collapses two decisions that share a long common prefix (the amount at the
  // end, 20 vs 2000) into one key - and the second question never reaches Nico.
  const norm = reason.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(`${kind}:${norm}`).digest('hex').slice(0, 16);
}

/**
 * Where a goal notification goes: the chat AND the thread that own the goal.
 * `t<num>` thread names are Telegram forum topics (threadId); `m<num>` are
 * conversations that grew from one message (replyToMessageId binds the note
 * to it); `main` needs neither. Without this routing a reply to a decision
 * floats in #main and never reaches the goal's owning thread.
 */
export function goalNotifyTarget(scope: string): {
  chatKey: string;
  chatId: string;
  threadId?: string;
  replyToMessageId?: string;
} | null {
  const { chatKey, thread } = splitGoalScope(scope);
  const chatId = chatKey.split(':')[2] ?? '';
  if (!chatId) return null;
  if (/^t\d+$/.test(thread)) return { chatKey, chatId, threadId: thread.slice(1) };
  if (/^m\d+$/.test(thread)) return { chatKey, chatId, replyToMessageId: thread.slice(1) };
  return { chatKey, chatId };
}

/** One Telegram-legible piece, in Spanish, no JSON dumps. */
export function formatGoalMessage(kind: string, goal: Pick<Goal, 'title'>, reason: string): string {
  const r = reason.trim().slice(0, 600);
  switch (kind) {
    case 'hito':
      return `🎯 ${goal.title}: ${r}`;
    case 'bloqueo':
      return `🎯 "${goal.title}" está bloqueado: ${r}\nRespóndeme por aquí y sigo.`;
    case 'decision':
      return `🎯 "${goal.title}" necesita tu decisión: ${r}\nRespóndeme por aquí y sigo.`;
    case 'hecho':
      return `🎯 Objetivo cumplido: "${goal.title}". ${r}`;
    case 'error':
      return `🎯 "${goal.title}" falló en su último tick: ${r}\nLo reintento en el siguiente; si persiste, paúsalo o échame un ojo.`;
    default:
      // desconocido: la regla es "si dudas entre escalar o seguir, escala".
      return `🎯 ${goal.title}: ${r}`;
  }
}

type Row = {
  goal_id: string;
  nkey: string;
  text: string;
  delivered: number;
  attempts: number;
  created_at: string;
};

export class GoalNotifier {
  readonly #db: DatabaseSync;
  readonly #send: (goal: Goal, text: string) => Promise<boolean>;
  readonly #now: () => number;

  constructor(deps: {
    db: DatabaseSync;
    send: (goal: Goal, text: string) => Promise<boolean>;
    now?: () => number;
  }) {
    this.#db = deps.db;
    this.#send = deps.send;
    this.#now = deps.now ?? (() => Date.now());
    this.#db.exec(SCHEMA);
  }

  /**
   * Notify about a goal event, once per stable key. `duplicate` means Nico
   * already got this exact finding; `pending` means Telegram said no and the
   * row stays for the next tick's flush.
   */
  async report(goal: Goal, kind: string, reason: string): Promise<NotifyOutcome> {
    const key = notifyKey(kind, reason);
    const text = formatGoalMessage(kind, goal, reason);
    const existing = this.#db
      .prepare('SELECT delivered FROM goal_notifications WHERE goal_id = ? AND nkey = ?')
      .get(goal.id, key) as { delivered: number } | undefined;
    if (existing && existing.delivered === 1) return 'duplicate';
    if (!existing) {
      this.#db
        .prepare(
          'INSERT INTO goal_notifications (goal_id, nkey, text, delivered, attempts, created_at) VALUES (?, ?, ?, 0, 0, ?)',
        )
        .run(goal.id, key, text, new Date(this.#now()).toISOString());
    }
    return (await this.#attempt(goal, key, text)) ? 'sent' : 'pending';
  }

  /** Whether the goal still has undelivered notifications (a done goal's routine lives on this). */
  hasPending(goalId: string): boolean {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM goal_notifications WHERE goal_id = ? AND delivered = 0')
      .get(goalId) as { n: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  }

  /** Retry everything still undelivered. Called on every goal tick. */
  async flush(goal: Goal): Promise<void> {
    const rows = this.#db
      .prepare('SELECT * FROM goal_notifications WHERE goal_id = ? AND delivered = 0')
      .all(goal.id) as Row[];
    for (const row of rows) {
      const age = this.#now() - Date.parse(row.created_at);
      if (age > NOTIFY_RETRY_MAX_AGE_MS) {
        this.#db
          .prepare('DELETE FROM goal_notifications WHERE goal_id = ? AND nkey = ?')
          .run(row.goal_id, row.nkey);
        continue;
      }
      await this.#attempt(goal, row.nkey, row.text);
    }
  }

  async #attempt(goal: Goal, key: string, text: string): Promise<boolean> {
    let ok = false;
    try {
      ok = await this.#send(goal, text);
    } catch {
      ok = false;
    }
    if (ok) {
      this.#db
        .prepare(
          'UPDATE goal_notifications SET delivered = 1, delivered_at = ?, attempts = attempts + 1 WHERE goal_id = ? AND nkey = ?',
        )
        .run(new Date(this.#now()).toISOString(), goal.id, key);
    } else {
      this.#db
        .prepare(
          'UPDATE goal_notifications SET attempts = attempts + 1 WHERE goal_id = ? AND nkey = ?',
        )
        .run(goal.id, key);
    }
    return ok;
  }
}
