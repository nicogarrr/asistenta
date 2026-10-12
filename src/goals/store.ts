/**
 * Long-haul goals (capability 4): Nico states ONE objective in natural
 * language, the daemon decomposes it into a plan, and ticks execute it over
 * days. This table is the durable half: everything a tick needs after a
 * daemon restart lives here, never in process memory.
 *
 * Why not the workstreams table: a workstream is the short prompt projection
 * (one line per open front); a goal carries the full approved plan, its cron
 * cadence, the per-day tick budget and the pending question. The workstream
 * still exists for an active goal - it is how every other conversation knows
 * the goal is out there - as a reference (workstreamId), not a copy.
 *
 * Why statuses include `proposed`: creating a goal is a commitment of days of
 * autonomous work and model spend, so nothing activates on the model's word.
 * A goal is born `proposed` (plan shown to Nico) and only `activate` moves it
 * to `active` - and that call is hardcoded as an always-ask in the Gate, the
 * same treatment as a factory install.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type GoalStatus = 'proposed' | 'active' | 'paused' | 'blocked' | 'done' | 'cancelled';

export interface GoalStep {
  text: string;
  done: boolean;
  note?: string;
}

export interface Goal {
  id: string;
  /** thread.key of the chat that owns the goal: scope comes from the caller, never from the model. */
  scope: string;
  title: string;
  /** Nico's own words. Kept verbatim so a tick never has to guess intent from a summary. */
  verbatim: string;
  plan: GoalStep[];
  status: GoalStatus;
  /** 5-field local cron; set at proposal time, live while active. */
  cadence: string | null;
  /** Why it is blocked / which decision is pending. Cleared on resume. */
  blockedReason: string | null;
  /**
   * When the block began. Kept apart from updatedAt: an avance also bumps
   * updatedAt, and the human-answer evidence window must start at the BLOCK.
   */
  blockedAt: string | null;
  lastOutcome: string | null;
  lastTickAt: string | null;
  /** Local day the tick counter belongs to (YYYY-MM-DD); a new day resets it. */
  ticksDay: string;
  ticksToday: number;
  workstreamId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A person tracks few long goals at once; past 3 the autonomy is noise and
 * spend. The cap is GLOBAL - three active goals in total across every chat,
 * not three per chat (the approved rule was "máx 3 goals activos", sin más).
 */
export const MAX_ACTIVE_GOALS = 3;
/** Proposed goals wait for a human yes; cap the waiting room so it cannot pile up. */
export const MAX_PROPOSED_GOALS = 5;
/** Anti-loop ceiling per goal: a tick that produces nothing must not spin all day. */
export const MAX_TICKS_PER_DAY = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  title         TEXT NOT NULL,
  verbatim      TEXT NOT NULL,
  plan          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('proposed','active','paused','blocked','done','cancelled')),
  cadence       TEXT,
  blocked_reason TEXT,
  blocked_at    TEXT,
  last_outcome  TEXT,
  last_tick_at  TEXT,
  ticks_day     TEXT NOT NULL DEFAULT '',
  ticks_today   INTEGER NOT NULL DEFAULT 0,
  workstream_id TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_scope ON goals(scope, status);
`;

type GoalRow = {
  id: string;
  scope: string;
  title: string;
  verbatim: string;
  plan: string;
  status: string;
  cadence: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
  last_outcome: string | null;
  last_tick_at: string | null;
  ticks_day: string;
  ticks_today: number;
  workstream_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Splits a goal scope back into its chat key and thread name. A scope IS a
 * thread key (`<chatKey>#<threadName>`) and the chat key itself never contains
 * '#', so the first '#' is the boundary. Execution and notification routing
 * both need the full pair: resolving only the chat key would silently move
 * the goal's work, and the questions it asks, into #main.
 */
export function splitGoalScope(scope: string): { chatKey: string; thread: string } {
  const hash = scope.indexOf('#');
  if (hash === -1) return { chatKey: scope, thread: 'main' };
  return { chatKey: scope.slice(0, hash), thread: scope.slice(hash + 1) || 'main' };
}

const COLUMNS =
  'id, scope, title, verbatim, plan, status, cadence, blocked_reason, blocked_at, last_outcome, last_tick_at, ticks_day, ticks_today, workstream_id, created_at, updated_at';

function mapGoal(r: GoalRow): Goal {
  let plan: GoalStep[] = [];
  try {
    const parsed = JSON.parse(r.plan) as unknown;
    if (Array.isArray(parsed)) plan = parsed as GoalStep[];
  } catch {
    /* a corrupt plan row reads as an empty plan, never as a crash */
  }
  return {
    id: r.id,
    scope: r.scope,
    title: r.title,
    verbatim: r.verbatim,
    plan,
    status: r.status as GoalStatus,
    cadence: r.cadence,
    blockedReason: r.blocked_reason,
    blockedAt: r.blocked_at,
    lastOutcome: r.last_outcome,
    lastTickAt: r.last_tick_at,
    ticksDay: r.ticks_day,
    ticksToday: Number(r.ticks_today),
    workstreamId: r.workstream_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class GoalStore {
  readonly #db: DatabaseSync;

  constructor(opts: { db: DatabaseSync }) {
    this.#db = opts.db;
    this.#db.exec(SCHEMA);
    try {
      // Databases written before blocked_at existed get the column here.
      this.#db.exec('ALTER TABLE goals ADD COLUMN blocked_at TEXT');
    } catch {
      /* already there */
    }
  }

  #count(scope: string, status: GoalStatus): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM goals WHERE scope = ? AND status = ?')
      .get(scope, status) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** The active cap is global: every chat's actives count against it. */
  #countActive(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM goals WHERE status = 'active'").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  propose(input: {
    scope: string;
    title: string;
    verbatim: string;
    plan: GoalStep[];
    cadence: string;
  }): Goal {
    if (this.#count(input.scope, 'proposed') >= MAX_PROPOSED_GOALS) {
      throw new Error(
        `Ya hay ${MAX_PROPOSED_GOALS} objetivos propuestos esperando respuesta. Activa o cancela alguno antes de proponer otro.`,
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO goals (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'proposed', ?, NULL, NULL, NULL, NULL, '', 0, NULL, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        input.title,
        input.verbatim,
        JSON.stringify(input.plan),
        input.cadence,
        now,
        now,
      );
    const goal = this.read(id);
    if (!goal) throw new Error('el objetivo recién propuesto no se puede leer');
    return goal;
  }

  /** proposed -> active. The only door in, and capped: autonomy is a scarce resource. */
  activate(id: string, workstreamId: string | null): void {
    const goal = this.#mustRead(id);
    if (goal.status !== 'proposed') {
      throw new Error(`Solo se activa un objetivo propuesto; "${goal.title}" está ${goal.status}.`);
    }
    if (this.#countActive() >= MAX_ACTIVE_GOALS) {
      throw new Error(
        `Ya hay ${MAX_ACTIVE_GOALS} objetivos activos. Pausa o cancela uno antes de activar otro.`,
      );
    }
    this.#set(id, { status: 'active', workstream_id: workstreamId });
  }

  /**
   * Links the workstream projection AFTER activation succeeded. The tool
   * activates first and attaches second, so a cap/status rejection can never
   * leave an orphaned workstream behind.
   */
  attachWorkstream(id: string, workstreamId: string): void {
    this.#mustRead(id);
    this.#set(id, { workstream_id: workstreamId });
  }

  pause(id: string): void {
    const goal = this.#mustRead(id);
    if (goal.status !== 'active')
      throw new Error(`Solo se pausa un objetivo activo; está ${goal.status}.`);
    this.#set(id, { status: 'paused' });
  }

  /** paused or blocked -> active. From blocked it also clears the pending question. */
  resume(id: string): void {
    const goal = this.#mustRead(id);
    if (goal.status !== 'paused' && goal.status !== 'blocked') {
      throw new Error(`Solo se reanuda un objetivo pausado o bloqueado; está ${goal.status}.`);
    }
    // The cap applies to EVERY transition into active, not just to activate:
    // a paused/blocked goal sits outside the count, so resume re-checks it.
    if (this.#countActive() >= MAX_ACTIVE_GOALS) {
      throw new Error(
        `Ya hay ${MAX_ACTIVE_GOALS} objetivos activos. Pausa o cancela uno antes de reanudar este.`,
      );
    }
    this.#set(id, { status: 'active', blocked_reason: null, blocked_at: null });
  }

  block(id: string, reason: string): void {
    const goal = this.#mustRead(id);
    if (goal.status !== 'active') return; // a paused goal cannot regress to blocked
    this.#set(id, {
      status: 'blocked',
      blocked_reason: reason,
      blocked_at: new Date().toISOString(),
    });
  }

  complete(id: string): void {
    this.#mustRead(id);
    this.#set(id, { status: 'done', blocked_reason: null, blocked_at: null });
  }

  cancel(id: string): void {
    const goal = this.#mustRead(id);
    if (goal.status === 'done')
      throw new Error('Un objetivo cumplido no se cancela; ya está hecho.');
    this.#set(id, { status: 'cancelled', blocked_reason: null, blocked_at: null });
  }

  updatePlan(id: string, plan: GoalStep[]): void {
    this.#mustRead(id);
    this.#set(id, { plan: JSON.stringify(plan) });
  }

  /**
   * Counts a tick and records its outcome tag. The counter is per LOCAL day:
   * the first tick of a new day resets it, so MAX_TICKS_PER_DAY never strands
   * a goal forever - it just stops a spinning day.
   */
  noteTick(id: string, outcome: string, dayKey: string): void {
    const goal = this.#mustRead(id);
    const sameDay = goal.ticksDay === dayKey;
    this.#db
      .prepare(
        `UPDATE goals SET last_outcome = ?, last_tick_at = ?, ticks_day = ?, ticks_today = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        outcome,
        new Date().toISOString(),
        dayKey,
        sameDay ? goal.ticksToday + 1 : 1,
        new Date().toISOString(),
        id,
      );
  }

  tickAllowed(goal: Goal, dayKey: string): boolean {
    if (goal.ticksDay !== dayKey) return true;
    return goal.ticksToday < MAX_TICKS_PER_DAY;
  }

  read(id: string): Goal | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM goals WHERE id = ?`).get(id) as
      | GoalRow
      | undefined;
    return row ? mapGoal(row) : null;
  }

  list(scope?: string): Goal[] {
    const rows = (
      scope === undefined
        ? this.#db.prepare(`SELECT ${COLUMNS} FROM goals ORDER BY updated_at DESC`).all()
        : this.#db
            .prepare(`SELECT ${COLUMNS} FROM goals WHERE scope = ? ORDER BY updated_at DESC`)
            .all(scope)
    ) as GoalRow[];
    return rows.map(mapGoal);
  }

  #mustRead(id: string): Goal {
    const goal = this.read(id);
    if (!goal) throw new Error(`No existe el objetivo: ${id}`);
    return goal;
  }

  #set(id: string, fields: Record<string, string | null>): void {
    const sets = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.#db
      .prepare(`UPDATE goals SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), new Date().toISOString(), id);
  }
}
