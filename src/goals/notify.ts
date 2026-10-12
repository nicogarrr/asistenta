/**
 * Goal notifications: the "te habla solo si hay novedad o decisión" half of
 * long-haul goals. Same discipline as the vigilante, for the same reasons:
 *
 * 1. Each finding is notified ONCE. The key is stable (kind + normalised
 *    reason), so a milestone re-detected on the next tick is a duplicate, not
 *    a second message - and an in-flight claim per (goal, key) keeps a tick,
 *    the boot flush and the delivery engine from sending the same row twice
 *    while one send is still on the wire. Exactly-once is NOT promised when
 *    the network answer is uncertain (delivered-but-threw): the claim releases
 *    on failure and the retry decides, so at worst a message repeats - the
 *    failure mode that loses nothing.
 * 2. A failed send is retried, not forgotten: only a confirmed delivery marks
 *    the row. Pending rows are re-attempted on every tick AND by an independent
 *    delivery engine on its own clock (flushAll), and dropped after a day, so
 *    a blocked chat cannot be spammed forever and a paused or daily goal cannot
 *    strand a question.
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

/**
 * The delivery engine's own clock (wired as an interval in cli.ts): retries
 * must not depend on the goal's cron - a daily goal with a failed send right
 * after its tick would otherwise get the next attempt AFTER the 24h drop.
 */
export const NOTIFY_FLUSH_INTERVAL_MS = 5 * 60_000;

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
  /** Returns the sent message id, or null when the transport said no. */
  readonly #send: (goal: Goal, text: string) => Promise<string | null>;
  readonly #resolveGoal: (id: string) => Goal | null;
  readonly #now: () => number;
  /** (goal_id:nkey) with a send on the wire right now: one delivery path at a time per row. */
  readonly #inflight = new Set<string>();
  /** Reentrancy guard: delivery loops never overlap each other. */
  #flushingAll = false;

  constructor(deps: {
    db: DatabaseSync;
    send: (goal: Goal, text: string) => Promise<string | null>;
    resolveGoal: (id: string) => Goal | null;
    now?: () => number;
  }) {
    this.#db = deps.db;
    this.#send = deps.send;
    this.#resolveGoal = deps.resolveGoal;
    this.#now = deps.now ?? (() => Date.now());
    this.#db.exec(SCHEMA);
    try {
      // Databases written before sent_id existed get the column here.
      this.#db.exec('ALTER TABLE goal_notifications ADD COLUMN sent_id TEXT');
    } catch {
      /* already there */
    }
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
    const r = await this.#attempt(goal, key, text);
    if (r === 'sent') return 'sent';
    if (r === 'skipped') {
      // Another path was delivering this exact row: it either landed
      // (duplicate) or stays for the next retry (pending).
      const now = this.#db
        .prepare('SELECT delivered FROM goal_notifications WHERE goal_id = ? AND nkey = ?')
        .get(goal.id, key) as { delivered: number } | undefined;
      return now?.delivered === 1 ? 'duplicate' : 'pending';
    }
    return 'pending';
  }

  /** Whether the goal still has undelivered notifications (a done goal's routine lives on this). */
  hasPending(goalId: string): boolean {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM goal_notifications WHERE goal_id = ? AND delivered = 0')
      .get(goalId) as { n: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  }

  /**
   * The owning goal's scope for a delivered message: durable reply routing.
   * Telegram message ids are PER CHAT, never global, so the lookup is by full
   * destination identity (chatKey, which includes the account) + sent_id -
   * two chats holding the same sent_id resolve to their own goal each.
   */
  scopeBySentId(chatKey: string, sentId: string): string | null {
    const rows = this.#db
      .prepare('SELECT goal_id FROM goal_notifications WHERE sent_id = ? ORDER BY created_at DESC')
      .all(sentId) as { goal_id: string }[];
    for (const row of rows) {
      const goal = this.#resolveGoal(row.goal_id);
      if (goal && splitGoalScope(goal.scope).chatKey === chatKey) return goal.scope;
    }
    return null;
  }

  /**
   * Retry every pending notification of EVERY goal, whatever its status. This
   * is the delivery engine's loop: independent of any goal's cron, and it
   * never runs work - it only delivers.
   */
  async flushAll(): Promise<void> {
    if (this.#flushingAll) return; // delivery loops never overlap
    this.#flushingAll = true;
    try {
      await this.#flushAllInner();
    } finally {
      this.#flushingAll = false;
    }
  }

  async #flushAllInner(): Promise<void> {
    const ids = this.#db
      .prepare('SELECT DISTINCT goal_id FROM goal_notifications WHERE delivered = 0')
      .all() as { goal_id: string }[];
    for (const { goal_id } of ids) {
      const goal = this.#resolveGoal(goal_id);
      if (!goal) {
        // The goal is gone: its pending notes die with it.
        this.#db.prepare('DELETE FROM goal_notifications WHERE goal_id = ?').run(goal_id);
        continue;
      }
      await this.flush(goal);
    }
  }

  /** Retry everything still undelivered. Called on every goal tick. */
  async flush(goal: Goal): Promise<void> {
    const rows = this.#db
      .prepare(
        'SELECT * FROM goal_notifications WHERE goal_id = ? AND delivered = 0 ORDER BY created_at, nkey',
      )
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

  /**
   * One send attempt. Returns 'sent' when THIS path delivered, 'pending' when
   * the transport said no, and 'skipped' when the row no longer needs sending
   * (claimed elsewhere, already delivered, expired or deleted).
   */
  async #attempt(goal: Goal, key: string, text: string): Promise<'sent' | 'pending' | 'skipped'> {
    // In-flight exclusion per (goal, key) for EVERY path: report, tick flush,
    // boot flush and the engine can race each other; only one send per row
    // may be on the wire at a time. The claim releases on failure so the
    // retry is never lost.
    const claim = `${goal.id}:${key}`;
    if (this.#inflight.has(claim)) return 'skipped';
    this.#inflight.add(claim);
    try {
      // Re-read AFTER claiming, BEFORE sending: the caller's snapshot (a flush
      // batch, a pre-check in report) may be stale - another path may have
      // delivered, expired or deleted this exact row while an earlier send of
      // the same batch was on the wire. Never send from a stale snapshot.
      const row = this.#db
        .prepare(
          'SELECT delivered, created_at FROM goal_notifications WHERE goal_id = ? AND nkey = ?',
        )
        .get(goal.id, key) as { delivered: number; created_at: string } | undefined;
      if (!row || row.delivered === 1) return 'skipped';
      if (this.#now() - Date.parse(row.created_at) > NOTIFY_RETRY_MAX_AGE_MS) {
        this.#db
          .prepare('DELETE FROM goal_notifications WHERE goal_id = ? AND nkey = ?')
          .run(goal.id, key);
        return 'skipped';
      }
      let sentId: string | null = null;
      try {
        sentId = await this.#send(goal, text);
      } catch {
        sentId = null;
      }
      if (sentId) {
        // The sent id is stored: reply routing survives a daemon restart.
        this.#db
          .prepare(
            'UPDATE goal_notifications SET delivered = 1, delivered_at = ?, sent_id = ?, attempts = attempts + 1 WHERE goal_id = ? AND nkey = ?',
          )
          .run(new Date(this.#now()).toISOString(), sentId, goal.id, key);
        return 'sent';
      }
      this.#db
        .prepare(
          'UPDATE goal_notifications SET attempts = attempts + 1 WHERE goal_id = ? AND nkey = ?',
        )
        .run(goal.id, key);
      return 'pending';
    } finally {
      // The claim is held until the state update above is fully written.
      this.#inflight.delete(claim);
    }
  }
}
