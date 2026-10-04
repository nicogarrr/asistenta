import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every attempt, kept forever.
 *
 * The loop is allowed to throw work away, never to hide it. A discarded attempt is the
 * most informative thing in the system: it is the record of which ideas were tried and
 * did not work, and without it the loop retries the same dead end every week while
 * forgetting that it already failed. Append-only, one JSON object per line, so a crash
 * mid-week loses nothing and the file can be read while the daemon holds it open.
 */

export type AttemptKind = 'hypothesis' | 'patch' | 'verdict';

export interface Attempt {
  /** Monotonic id. Also the sequence number in the file. */
  id: number;
  /** ISO week, so a year of attempts is a list of weeks rather than a wall. */
  week: string;
  kind: AttemptKind;
  /** What the attempt was trying to do, in one sentence. */
  hypothesis: string;
  /** The commit it was measured from, and the commit the measurement came from. */
  kernel?: string;
  candidate?: string;
  measured?: Record<string, number>;
  verdict?: 'promote' | 'retry' | 'discard';
  reason?: string;
  /** How many tries this hypothesis has had. The loop gives up at the limit. */
  tries?: number;
}

export class Archive {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    mkdirSync(join(path, '..'), { recursive: true });
  }

  /** Append one record. Fails loudly: losing the record would be worse than the week. */
  add(attempt: Omit<Attempt, 'id'> & { id?: number }): Attempt {
    const full: Attempt = { ...attempt, id: attempt.id ?? this.nextId() };
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, 'utf8');
    return full;
  }

  /** Highest id already written, or 0. Reading the file is the only source of truth. */
  nextId(): number {
    return this.read().reduce((n, a) => Math.max(n, a.id), 0) + 1;
  }

  /**
   * Read every record.
   *
   * A truncated last line is skipped rather than thrown: the file is appended to while
   * the process runs, and a half-written line means the loop was killed mid-write, which
   * is not a reason to refuse to start.
   */
  read(): Attempt[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    const out: Attempt[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Attempt;
        if (typeof parsed.id === 'number') out.push(parsed);
      } catch {
        // A partial line from a killed process. Skipping it keeps the rest readable.
      }
    }
    return out;
  }

  /** Everything recorded for one ISO week, oldest first. */
  week(week: string): Attempt[] {
    return this.read().filter((a) => a.week === week);
  }

  /** The hypotheses that already failed, so the loop does not retry them blindly. */
  deadEnds(week?: string): string[] {
    const rows = week ? this.week(week) : this.read();
    return rows.filter((a) => a.verdict === 'discard' && a.hypothesis).map((a) => a.hypothesis);
  }
}

/** ISO week label, e.g. `2026-W15`. Weeks are the unit of the loop, so they are named. */
export function isoWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Thursday of this week decides the year: the week containing 1 January is W01.
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
