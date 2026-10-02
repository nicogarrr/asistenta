/**
 * Workstreams: the few long-running things the user is in the middle of, each
 * with its goal, constraints, decisions and next step.
 *
 * Why this is a table and not another markdown file: a workstream is rewritten
 * on almost every turn (a new decision, a new next step), and the prompt needs
 * all of them at once. That is a `SELECT`, not a directory scan.
 *
 * Why `forget` writes a tombstone instead of DELETE: forgetting happens in the
 * middle of a conversation, where a half-finished save may land afterwards. A
 * deleted row can be recreated by that late save; a `status='forgotten'` row
 * cannot, and history stays auditable ("we dropped the kitchen remodelling in
 * October") instead of vanishing.
 *
 * Why there is a cap on active workstreams: the point of this table is to fit
 * in a prompt. Eight open fronts is already more than a person tracks in their
 * head; past that, `index()` stops being a focus tool and becomes noise, so the
 * store refuses to grow instead of silently degrading the prompt.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type WorkstreamStatus = 'active' | 'paused' | 'done' | 'forgotten';

export interface Workstream {
  id: string;
  scope: string;
  title: string;
  status: WorkstreamStatus;
  goal: string;
  constraints: string | null;
  decisions: string | null;
  observations: string | null;
  nextSteps: string | null;
  updatedAt: number;
}

/** How many workstreams one scope may have open before the store says no. */
export const MAX_ACTIVE = 8;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workstreams (
  id           TEXT PRIMARY KEY,
  scope        TEXT,
  title        TEXT,
  status       TEXT CHECK (status IN ('active','paused','done','forgotten')),
  goal         TEXT,
  constraints  TEXT,
  decisions    TEXT,
  observations TEXT,
  next_steps   TEXT,
  updated_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workstreams_scope ON workstreams(scope, status, updated_at);
`;

const STATUS_LABEL: Record<WorkstreamStatus, string> = {
  active: 'activo',
  paused: 'pausado',
  done: 'hecho',
  forgotten: 'olvidado',
};

/**
 * Column names per updatable field. `id` and `updatedAt` are deliberately
 * absent: identity and freshness are the store's business, not the caller's.
 */
const UPDATABLE: Array<{ field: keyof Workstream; column: string }> = [
  { field: 'scope', column: 'scope' },
  { field: 'title', column: 'title' },
  { field: 'status', column: 'status' },
  { field: 'goal', column: 'goal' },
  { field: 'constraints', column: 'constraints' },
  { field: 'decisions', column: 'decisions' },
  { field: 'observations', column: 'observations' },
  { field: 'nextSteps', column: 'next_steps' },
];

type WorkstreamRow = {
  id: string;
  scope: string | null;
  title: string | null;
  status: string | null;
  goal: string | null;
  constraints: string | null;
  decisions: string | null;
  observations: string | null;
  next_steps: string | null;
  updated_at: number;
};

function mapWorkstream(r: WorkstreamRow): Workstream {
  return {
    id: String(r.id),
    scope: r.scope ?? '',
    title: r.title ?? '',
    status: (r.status ?? 'active') as WorkstreamStatus,
    goal: r.goal ?? '',
    constraints: r.constraints ?? null,
    decisions: r.decisions ?? null,
    observations: r.observations ?? null,
    nextSteps: r.next_steps ?? null,
    updatedAt: Number(r.updated_at),
  };
}

/** One line per workstream in the prompt index: no embedded newlines. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export class WorkstreamStore {
  readonly #db: DatabaseSync;

  constructor(opts: { db: DatabaseSync }) {
    this.#db = opts.db;
    this.#db.exec(SCHEMA);
  }

  create(scope: string, title: string, goal: string): string {
    const open = this.#db
      .prepare("SELECT COUNT(*) AS n FROM workstreams WHERE scope = ? AND status = 'active'")
      .get(scope) as { n: number } | undefined;
    if (Number(open?.n ?? 0) >= MAX_ACTIVE) {
      throw new Error(
        `Has alcanzado el límite de ${MAX_ACTIVE} frentes de trabajo activos en este ámbito. ` +
          'Olvida uno (forget) antes de crear otro.',
      );
    }
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO workstreams
           (id, scope, title, status, goal, constraints, decisions, observations, next_steps, updated_at)
         VALUES (?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(id, scope, title, goal, Date.now());
    return id;
  }

  update(id: string, fields: Partial<Workstream>): void {
    const current = this.read(id);
    if (!current) throw new Error(`no existe el frente de trabajo: ${id}`);
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const { field, column } of UPDATABLE) {
      const value = fields[field];
      if (value === undefined) continue;
      // A forgotten workstream is a tombstone: a save that was already in
      // flight when it was forgotten must not bring it back by rewriting
      // status along with the rest of the fields.
      if (field === 'status' && current.status === 'forgotten') continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);
    this.#db.prepare(`UPDATE workstreams SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  read(id: string): Workstream | null {
    const row = this.#db
      .prepare(
        `SELECT id, scope, title, status, goal, constraints, decisions, observations, next_steps, updated_at
         FROM workstreams WHERE id = ?`,
      )
      .get(id) as WorkstreamRow | undefined;
    return row ? mapWorkstream(row) : null;
  }

  /** Open workstreams, most recently touched first. */
  active(scope?: string, limit = MAX_ACTIVE): Workstream[] {
    const cap = Math.max(1, Math.floor(limit));
    const filter = scope === undefined ? '' : ' AND scope = ?';
    const params: Array<string | number> = [];
    if (scope !== undefined) params.push(scope);
    params.push(cap);
    const rows = this.#db
      .prepare(
        `SELECT id, scope, title, status, goal, constraints, decisions, observations, next_steps, updated_at
         FROM workstreams WHERE status = 'active'${filter}
         ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as WorkstreamRow[];
    return rows.map(mapWorkstream);
  }

  /** Tombstone, never DELETE: see the file header for why. */
  forget(id: string): void {
    const result = this.#db
      .prepare("UPDATE workstreams SET status = 'forgotten', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
    if (Number(result.changes) === 0) throw new Error(`no existe el frente de trabajo: ${id}`);
  }

  /**
   * Compact Spanish list for prompt injection. One line per open workstream:
   * title, state, goal and next step, nothing the model can drown in.
   */
  index(scope?: string): string {
    const filter = scope === undefined ? '' : ' AND scope = ?';
    const params: Array<string | number> = [];
    if (scope !== undefined) params.push(scope);
    const rows = this.#db
      .prepare(
        `SELECT id, scope, title, status, goal, constraints, decisions, observations, next_steps, updated_at
         FROM workstreams WHERE status IN ('active', 'paused')${filter}
         ORDER BY updated_at DESC, rowid DESC`,
      )
      .all(...params) as WorkstreamRow[];
    if (rows.length === 0) return 'Sin frentes de trabajo abiertos.';
    const lines = rows.map((row) => {
      const work = mapWorkstream(row);
      const bits = [`objetivo: ${oneLine(work.goal)}`];
      if (work.nextSteps) bits.push(`siguiente: ${oneLine(work.nextSteps)}`);
      return `- [${STATUS_LABEL[work.status]}] ${oneLine(work.title)} — ${bits.join('; ')}`;
    });
    return `Frentes de trabajo:\n${lines.join('\n')}`;
  }
}
