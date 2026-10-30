/**
 * Instincts: patterns the agent has seen often enough to act on without being
 * asked again ("she asks for the weather before leaving", "close with a short
 * answer").
 *
 * Why confidence counts observations instead of storing a boolean: one sighting
 * is noise, five is a habit, ten is a rule. The thresholds are explicit so the
 * agent can explain *why* it assumed something, and a single wrong observation
 * never becomes behaviour.
 *
 * Why decay exists: a pattern the user stopped showing must stop steering the
 * agent. Confidence only ever going up would turn old accidents into permanent
 * rules, and the user has no way to see that happening.
 *
 * Why (pattern, category, scope) is the identity: the same words mean different
 * things per channel ("here" in a chat vs in a shell), and observing the same
 * pattern twice must strengthen it, not fork a copy that dilutes the count.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * What kind of pattern this is:
 * - `seq`: order of actions ("send the mail only after attaching the file").
 * - `pref`: a user preference ("answers in Spanish").
 * - `fix`: a recurring problem and its fix ("printer offline -> restart spooler").
 * - `combo`: several of the above that only make sense together.
 */
export type InstinctCategory = 'seq' | 'pref' | 'fix' | 'combo';

export interface Instinct {
  id: string;
  pattern: string;
  category: InstinctCategory;
  scope: string;
  confidence: number;
  lastSeen: number;
}

/** Below this an observation is anecdotal; at it, it becomes a suggestion. */
export const MATURE_THRESHOLD = 5;
/** At this count the pattern is promoted to something the agent may rely on. */
export const RULE_THRESHOLD = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instincts (
  id         TEXT PRIMARY KEY,
  pattern    TEXT,
  category   TEXT,
  scope      TEXT,
  confidence INTEGER DEFAULT 1,
  last_seen  INTEGER,
  UNIQUE (pattern, category, scope)
);
CREATE INDEX IF NOT EXISTS idx_instincts_scope ON instincts(scope, confidence);
CREATE TABLE IF NOT EXISTS instinct_sweeps (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  last_at INTEGER NOT NULL
);
`;

const DAY_MS = 86_400_000;
/**
 * The daemon sweeps at every boot. Without a floor, ten restarts in one
 * afternoon (updates, a Windows reboot, a crash loop) took ten points off every
 * pattern unseen for 90 days and wiped out rules the user had built over months.
 * At most one sweep per day counts; the rest are no-ops.
 */
export const DECAY_MIN_INTERVAL_MS = DAY_MS;

type InstinctRow = {
  id: string;
  pattern: string | null;
  category: string | null;
  scope: string | null;
  confidence: number;
  last_seen: number;
};

function mapInstinct(r: InstinctRow): Instinct {
  return {
    id: String(r.id),
    pattern: r.pattern ?? '',
    category: (r.category ?? 'pref') as InstinctCategory,
    scope: r.scope ?? 'global',
    confidence: Number(r.confidence),
    lastSeen: Number(r.last_seen),
  };
}

export class InstinctStore {
  readonly #db: DatabaseSync;

  constructor(opts: { db: DatabaseSync }) {
    this.#db = opts.db;
    this.#db.exec(SCHEMA);
  }

  /**
   * One observation of a pattern. Idempotent per (pattern, category, scope):
   * seeing the same thing again raises confidence instead of adding a row.
   */
  observe(pattern: string, category: InstinctCategory, scope = 'global'): void {
    const clean = pattern.trim();
    if (!clean) throw new Error('un patrón vacío no es observable');
    this.#db
      .prepare(
        `INSERT INTO instincts (id, pattern, category, scope, confidence, last_seen)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (pattern, category, scope) DO UPDATE SET
           confidence = instincts.confidence + 1,
           last_seen = excluded.last_seen`,
      )
      .run(randomUUID(), clean, category, scope, Date.now());
  }

  /** Patterns seen often enough to be worth offering to the user. */
  suggest(scope = 'global'): Instinct[] {
    return this.#atLeast(MATURE_THRESHOLD, scope);
  }

  /** Patterns seen so often the agent may act on them without asking. */
  rules(scope = 'global'): Instinct[] {
    return this.#atLeast(RULE_THRESHOLD, scope);
  }

  /**
   * One point of confidence off every pattern not seen in `days`, deleting the
   * ones that hit zero. Returns how many were touched. Decay is per sweep, but
   * sweeps closer than {@link DECAY_MIN_INTERVAL_MS} to the previous one do
   * nothing (and return 0), so restarting the daemon often never speeds it up.
   */
  decay(days = 90): number {
    const now = Date.now();
    const last = this.#db.prepare('SELECT last_at FROM instinct_sweeps WHERE id = 1').get() as
      | { last_at: number }
      | undefined;
    if (last && now >= Number(last.last_at) && now - Number(last.last_at) < DECAY_MIN_INTERVAL_MS)
      return 0;
    this.#db
      .prepare(
        'INSERT INTO instinct_sweeps (id, last_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET last_at = excluded.last_at',
      )
      .run(now);
    const cutoff = now - days * DAY_MS;
    const result = this.#db
      .prepare(
        'UPDATE instincts SET confidence = MAX(confidence - 1, 0) WHERE last_seen < ? AND confidence > 0',
      )
      .run(cutoff);
    this.#db.prepare('DELETE FROM instincts WHERE last_seen < ? AND confidence <= 0').run(cutoff);
    return Number(result.changes);
  }

  /**
   * Force a pattern up to rule weight, e.g. after the user confirms it. Never
   * lowers a pattern already above it, and a confirmation counts as a sighting
   * (otherwise the next sweep would take the point straight back).
   */
  promote(id: string): void {
    const result = this.#db
      .prepare('UPDATE instincts SET confidence = MAX(confidence, ?), last_seen = ? WHERE id = ?')
      .run(RULE_THRESHOLD, Date.now(), id);
    if (Number(result.changes) === 0) throw new Error(`no existe el instinto: ${id}`);
  }

  #atLeast(min: number, scope: string): Instinct[] {
    const rows = this.#db
      .prepare(
        `SELECT id, pattern, category, scope, confidence, last_seen FROM instincts
         WHERE scope = ? AND confidence >= ?
         ORDER BY confidence DESC, last_seen DESC, rowid`,
      )
      .all(scope, min) as InstinctRow[];
    return rows.map(mapInstinct);
  }
}
