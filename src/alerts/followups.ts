/**
 * Things the user said they would do, and the gentle nudge to do them.
 *
 * The gap this closes is the one that makes most assistants forgettable: they answer
 * the question that was asked and never mention the one that was implied. "Te mando el
 * informe mañana" is a promise the user made to themselves, and an agent that remembers
 * it is the difference between a tool and something that feels like it is paying
 * attention.
 *
 * A note is tracked when it has a *due date* or a *contact subject*; both are the
 * shapes a follow-up takes. A due date is "the registration closes on Friday"; a
 * subject is "you have not answered Juan in three days". The tracker never decides what
 * matters - the agent does that at the moment it hears the promise - it only keeps
 * score and reports.
 *
 * `touch` is what makes "three days without answering" honest: the clock starts at the
 * last contact, not at the moment the note was created, or a subject the user talks to
 * every day would be reported as overdue forever.
 */

import type { DatabaseSync } from 'node:sqlite';
import { log } from '../log.js';

export interface Followup {
  id: string;
  scope: string;
  kind: string;
  subject: string;
  lastContact: number;
  dueAt: number;
  status: 'pending' | 'done';
  createdAt: number;
}

export interface FollowupTrackerOptions {
  db: DatabaseSync;
  /** How many hours of silence before something is worth mentioning. */
  windowHours?: number;
  /**
   * Injected clock. Without it the tracker stamps `Date.now()` on every write, and a
   * test that reasons about "three days ago" against a fixed date cannot express it:
   * the row says *today* and the silence clock has not started. Same reasoning as
   * `PromptCron`'s clock.
   */
  now?: () => number;
}

const DEFAULT_WINDOW_HOURS = 72;

function rowToFollowup(row: Record<string, unknown>): Followup {
  return {
    id: String(row.id ?? ''),
    scope: String(row.scope ?? ''),
    kind: String(row.kind ?? ''),
    subject: String(row.subject ?? ''),
    lastContact: Number(row.last_contact ?? 0),
    dueAt: Number(row.due_at ?? 0),
    status: row.status === 'done' ? 'done' : 'pending',
    createdAt: Number(row.created_at ?? 0),
  };
}

export class FollowupTracker {
  readonly #db: DatabaseSync;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options: FollowupTrackerOptions) {
    this.#db = options.db;
    this.#windowMs = Math.max(1, options.windowHours ?? DEFAULT_WINDOW_HOURS) * 3_600_000;
    this.#now = options.now ?? Date.now;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS followups (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        last_contact INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_followups_scope ON followups(scope);
    `);
  }

  /**
   * Remember a promise. `dueAt` is an epoch timestamp; pass `Date.now()` for a note
   * that has no date and is tracked purely by contact recency.
   */
  track(scope: string, kind: string, subject: string, dueAt: number): string {
    const id = `${kind}:${subject}`.slice(0, 200);
    const now = this.#now();
    this.#db
      .prepare(
        `INSERT INTO followups (id, scope, kind, subject, last_contact, due_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope,
           kind = excluded.kind,
           subject = excluded.subject,
           due_at = excluded.due_at,
           last_contact = excluded.last_contact,
           status = 'pending'`,
      )
      .run(id, scope, kind, subject, now, dueAt, now);
    return id;
  }

  /** Record that the user touched this subject again, so the silence clock restarts. */
  touch(scope: string, subject: string): void {
    this.#db
      .prepare(
        `UPDATE followups SET last_contact = ? WHERE scope = ? AND subject = ? AND status = 'pending'`,
      )
      .run(this.#now(), scope, subject);
  }

  /** Notes whose date has arrived. */
  due(now = Date.now()): Followup[] {
    return this.#db
      .prepare(
        `SELECT * FROM followups WHERE status = 'pending' AND due_at > 0 AND due_at <= ?
         ORDER BY due_at ASC`,
      )
      .all(now)
      .map((row) => rowToFollowup(row as Record<string, unknown>));
  }

  /** Notes nobody has touched in `days` days. Defaults to the tracker's own window. */
  overdue(days?: number, now = Date.now()): Followup[] {
    const windowDays = days ?? this.#windowMs / 86_400_000;
    const cutoff = now - windowDays * 24 * 3_600_000;
    return this.#db
      .prepare(
        `SELECT * FROM followups WHERE status = 'pending' AND (last_contact <= ? OR last_contact = 0)
         ORDER BY last_contact ASC`,
      )
      .all(cutoff)
      .map((row) => rowToFollowup(row as Record<string, unknown>));
  }

  resolve(id: string): void {
    this.#db.prepare(`UPDATE followups SET status = 'done' WHERE id = ?`).run(id);
  }

  /**
   * What to tell the user, in Spanish and without ceremony.
   *
   * Sorted by urgency and bounded: an agent that dumps a paragraph of reminders is an
   * agent the user mutes. The three most pressing things are enough to act on, and the
   * count makes it clear the list is not exhaustive.
   */
  summarize(now = Date.now()): string {
    const due = this.due(now);
    const late = this.overdue(3, now).filter((f) => !due.some((d) => d.id === f.id));
    const lines: string[] = [];

    for (const item of due.slice(0, 3)) {
      lines.push(`Vence: ${item.subject}`);
    }
    for (const item of late.slice(0, 3)) {
      const days = Math.max(1, Math.round((now - item.lastContact) / 86_400_000));
      lines.push(`Llevas ${days} d sin tocar: ${item.subject}`);
    }

    if (!lines.length) return 'Todo al día.';
    const extra = due.length + late.length - lines.length;
    return extra > 0 ? `${lines.join('\n')}\n…y ${extra} más.` : lines.join('\n');
  }

  list(scope?: string, limit = 20): Followup[] {
    const rows = scope
      ? (this.#db
          .prepare(`SELECT * FROM followups WHERE scope = ? ORDER BY created_at DESC LIMIT ?`)
          .all(scope, limit) as Record<string, unknown>[])
      : (this.#db
          .prepare(`SELECT * FROM followups ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as Record<string, unknown>[]);
    return rows.map(rowToFollowup);
  }

  /** Never throws: a broken tracker must not take the daemon down with it. */
  safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      log.warn('followup tracker failed', { err });
      return fallback;
    }
  }
}
