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

import { createHash } from 'node:crypto';
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
  /** Último empuje proactivo; 0/ausente = todavía no se ha avisado. */
  pushedAt?: number;
}

/** Ventana por defecto de `dueForPush`: un día de antelación. */
export const DEFAULT_PUSH_WINDOW_MS = 24 * 3_600_000;

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
    pushedAt: Number(row.pushed_at ?? 0),
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
        created_at INTEGER NOT NULL,
        pushed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_followups_scope ON followups(scope);
    `);
    // Bases creadas antes de los empujes: la columna se añade sin perder filas.
    // Va después del CREATE para que una base nueva no necesite el ALTER.
    const columns = this.#db.prepare('PRAGMA table_info(followups)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'pushed_at')) {
      this.#db.exec('ALTER TABLE followups ADD COLUMN pushed_at INTEGER NOT NULL DEFAULT 0');
    }
    this.#db.exec(
      'CREATE INDEX IF NOT EXISTS idx_followups_push ON followups(status, pushed_at, due_at)',
    );
  }

  /**
   * Remember a promise. `dueAt` is an epoch timestamp; pass 0 for a note that has
   * no date and is tracked purely by contact recency (`due()` only selects
   * `due_at > 0`, so 0 is the only value that never reads as "vencio").
   */
  track(scope: string, kind: string, subject: string, dueAt: number): string {
    const id = this.#idFor(scope, kind, subject);
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
           status = 'pending',
           pushed_at = CASE
             WHEN status = 'done' OR due_at <> excluded.due_at THEN 0
             ELSE pushed_at
           END`,
      )
      .run(id, scope, kind, subject, now, dueAt, now);
    return id;
  }

  /**
   * La misma nota en dos chats son dos notas. El id legible (`kind:asunto`) se
   * conserva para la primera; si ya lo usa OTRO chat, la nueva lleva un sufijo
   * estable derivado de su scope. Antes el id no tenía scope: la segunda nota
   * reescribía el scope de la primera y el chat original la perdía.
   */
  #idFor(scope: string, kind: string, subject: string): string {
    const existing = this.#db
      .prepare('SELECT id FROM followups WHERE scope = ? AND kind = ? AND subject = ? LIMIT 1')
      .get(scope, kind, subject) as { id?: unknown } | undefined;
    if (existing && typeof existing.id === 'string') return existing.id;
    const base = `${kind}:${subject}`.slice(0, 200);
    const owner = this.#db.prepare('SELECT scope FROM followups WHERE id = ?').get(base) as
      | { scope?: unknown }
      | undefined;
    if (!owner || owner.scope === scope) return base;
    const tag = createHash('sha1').update(scope).digest('hex').slice(0, 6);
    return `${base.slice(0, 192)}@${tag}`;
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

  /**
   * Lo que toca empujar al usuario: notas con fecha ya vencida o que vencen dentro
   * de `windowMs`, y que todavía no se han empujado. Las notas sin fecha (`dueAt = 0`)
   * no entran: no tienen un momento objetivo y su aviso por silencio es `overdue()`.
   *
   * `windowMs` se acota a cero en vez de aceptar negativos: una ventana negativa
   * convertiría el empuje en "solo lo que venció antes de ayer", que no es lo pedido.
   */
  dueForPush(nowMs: number, opts: { windowMs?: number } = {}): Followup[] {
    if (!Number.isFinite(nowMs)) return [];
    const requested = opts.windowMs;
    const windowMs =
      requested === undefined || !Number.isFinite(requested)
        ? DEFAULT_PUSH_WINDOW_MS
        : Math.max(0, requested);
    return this.#db
      .prepare(
        `SELECT * FROM followups
         WHERE status = 'pending' AND COALESCE(pushed_at, 0) = 0
           AND due_at > 0 AND due_at <= ?
         ORDER BY due_at ASC, created_at ASC`,
      )
      .all(nowMs + windowMs)
      .map((row) => rowToFollowup(row as Record<string, unknown>));
  }

  /**
   * Marca una nota como empujada para que `dueForPush` no la repita. Con la base en
   * fichero (`paths.db`) la marca sobrevive al reinicio; con `':memory:'`, como en
   * los tests, vive solo mientras dure esa conexión.
   */
  markPushed(id: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('markPushed necesita un instante válido');
    this.#db.prepare('UPDATE followups SET pushed_at = ? WHERE id = ?').run(ms, id);
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
  summarize(now = Date.now(), opts: { chatKey?: string } = {}): string {
    const mine = (f: Followup): boolean =>
      opts.chatKey === undefined || f.scope.startsWith(`${opts.chatKey}#`);
    const due = this.due(now).filter(mine);
    const late = this.overdue(3, now)
      .filter(mine)
      .filter((f) => !due.some((d) => d.id === f.id));
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
