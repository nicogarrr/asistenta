import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.js';

/**
 * Durable state, on `node:sqlite` (stable in Node 24, no native build step).
 *
 * The transcript of record is SessionStore (sessions + session_turns, FTS5);
 * this Store keeps routines, purchase_intents and kv. `purchase_intents` is
 * separate from any transcript on purpose: money state must be queryable
 * without replaying a conversation, and must survive the conversation being
 * compacted away.
 *
 * Legacy: databases written before the dead transcript tables were removed
 * may still carry `sessions`/`entries`/`entry_edits`. They are never read or
 * written now; dropping them would delete old history for no benefit, so
 * they are simply left alone.
 */

/**
 * A learned routine. Two shapes, both stored the same way:
 *
 * - `procedure`: numbered steps the agent can replay later ("how I check the
 *   trains"). Written by the /learn flow after it watches the user do a task once.
 * - `schedule`: a cron expression plus the prompt to run when it fires.
 *
 * `steps` is deliberately plain markdown rather than structured steps: the agent
 * writes it, and prose is what the model reads best. JSON would only add a parse
 * step between the model and its own memory.
 */

/**
 * A typed macro parameter (capability 3, PR4): `{nombre}` placeholders in a
 * procedure's steps make it a macro. The declared type is the whole contract -
 * every value is validated against it before any substitution, so a value is
 * always data and can never become prompt structure.
 */
export type RoutineParamType = 'fichero' | 'correo' | 'dominio' | 'texto';

export interface RoutineParam {
  name: string;
  type: RoutineParamType;
}

const ROUTINE_PARAM_TYPES: ReadonlySet<string> = new Set(['fichero', 'correo', 'dominio', 'texto']);
const ROUTINE_PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The one definition of a valid parameter contract, used when a contract is
 * built, saved and loaded. Names must be well-formed and unique, types must be
 * from the closed set; anything else is a corrupt contract (null), never a
 * silently degraded one. Own properties only: prototype keys are not names.
 */
export function validateRoutineParams(raw: unknown): RoutineParam[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const seen = new Set<string>();
  const out: RoutineParam[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    const name = Object.hasOwn(o, 'name') ? o.name : undefined;
    const type = Object.hasOwn(o, 'type') ? o.type : undefined;
    if (typeof name !== 'string' || !ROUTINE_PARAM_NAME.test(name) || seen.has(name)) return null;
    if (typeof type !== 'string' || !ROUTINE_PARAM_TYPES.has(type)) return null;
    seen.add(name);
    out.push({ name, type: type as RoutineParamType });
  }
  return out;
}

export interface Routine {
  id: string;
  /** chatKey, so routines are per chat unless deliberately global. */
  scope: string;
  name: string;
  kind: 'procedure' | 'schedule';
  /** Typed `{nombre}` placeholders declared in `steps`; null for plain routines. */
  params: RoutineParam[] | null;
  steps: string | null;
  prompt: string | null;
  /** 5- or 6-field cron, null for procedures. */
  schedule: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

export interface PurchaseIntent {
  id: string;
  conversationId: string | null;
  vendor: string;
  summary: string;
  amountCents: number;
  currency: string;
  status: 'draft' | 'at_checkout' | 'awaiting_human' | 'paid' | 'aborted' | 'expired' | 'unknown';
  reference: string | null;
  /** Free-form detail. Never put card numbers or CVV here. */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

-- Learned routines: the agent's own notes on how to do a recurring thing.
-- A routine is either a replayable procedure (steps) or a schedule (cron) that
-- fires a prompt. Both live here so "learning" survives a restart.
CREATE TABLE IF NOT EXISTS routines (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  params      TEXT,
  steps       TEXT,
  prompt      TEXT,
  schedule    TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  last_run_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_routines_scope ON routines(scope, name);

-- Money state. 'unknown' means "we do not know" and MUST NOT be retried blindly.
CREATE TABLE IF NOT EXISTS purchase_intents (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT,
  vendor         TEXT NOT NULL,
  summary        TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  status         TEXT NOT NULL,
  reference      TEXT,
  detail         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intents_status ON purchase_intents(status, created_at);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const VERSION = 1;

export class Store {
  readonly #db: DatabaseSync;

  constructor(file: string = paths.db) {
    mkdirSync(dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(SCHEMA);
    // Column migrations for databases written before a column existed. There is
    // no version ladder on purpose: each migration is a presence check plus an
    // ALTER, so running it twice is a no-op and the order never matters.
    const routineCols = (
      this.#db.prepare('SELECT name FROM pragma_table_info(?)').all('routines') as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    if (!routineCols.includes('params')) {
      this.#db.exec('ALTER TABLE routines ADD COLUMN params TEXT');
    }
    const row = this.#db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    if (!row) {
      this.#db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(VERSION);
    } else if (row.version > VERSION) {
      // Close before throwing: on Windows an open handle makes the file undeletable,
      // which turns a clear error message into a confusing EPERM later.
      this.#db.close();
      throw new Error(`database schema v${row.version} is newer than this build (v${VERSION})`);
    }
  }

  close(): void {
    this.#db.close();
  }

  // ---- purchase intents ---------------------------------------------------

  /**
   * Written BEFORE any checkout is opened. If the process dies after the vendor
   * charged us but before we recorded a reference, the intent is on disk and the
   * reconciler will find it.
   */
  createIntent(intent: Omit<PurchaseIntent, 'createdAt' | 'updatedAt'>): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO purchase_intents
           (id, conversation_id, vendor, summary, amount_cents, currency, status, reference, detail, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        intent.id,
        intent.conversationId,
        intent.vendor,
        intent.summary,
        intent.amountCents,
        intent.currency,
        intent.status,
        intent.reference,
        intent.detail,
        now,
        now,
        intent.expiresAt,
      );
  }

  updateIntentStatus(
    id: string,
    status: PurchaseIntent['status'],
    reference?: string | null,
    detail?: string | null,
  ): void {
    const current = this.getIntent(id);
    if (!current) throw new Error(`no such purchase intent: ${id}`);
    this.#db
      .prepare(
        'UPDATE purchase_intents SET status = ?, reference = ?, detail = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        status,
        reference === undefined ? current.reference : reference,
        detail === undefined ? current.detail : detail,
        new Date().toISOString(),
        id,
      );
  }

  getIntent(id: string): PurchaseIntent | null {
    const r = this.#db.prepare('SELECT * FROM purchase_intents WHERE id = ?').get(id) as
      | Record<string, string | number>
      | undefined;
    return r ? mapIntent(r) : null;
  }

  /**
   * Everything still in flight. `at_checkout` and `unknown` are the states that
   * must be reconciled on boot — they may correspond to real money movement.
   */
  listOpenIntents(): PurchaseIntent[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM purchase_intents WHERE status IN ('at_checkout','awaiting_human','unknown') ORDER BY created_at",
      )
      .all() as Array<Record<string, string | number>>;
    return rows.map(mapIntent);
  }

  /** Expire anything past its window. An expired intent is never retried. */
  sweepExpired(): number {
    const r = this.#db
      .prepare(
        "UPDATE purchase_intents SET status = 'expired', updated_at = ? WHERE status IN ('at_checkout','unknown') AND expires_at < ?",
      )
      .run(new Date().toISOString(), new Date().toISOString());
    return Number(r.changes);
  }

  // ---- routines ------------------------------------------------------------

  /**
   * Upsert by (scope, name) rather than by id: the user names routines in
   * conversation ("la compra", "Renfe"), so the name is the identity and a second
   * `/learn compra` updates instead of creating a duplicate.
   */
  saveRoutine(r: {
    id?: string;
    scope: string;
    name: string;
    kind: Routine['kind'];
    params?: RoutineParam[] | null;
    steps?: string | null;
    prompt?: string | null;
    schedule?: string | null;
    enabled?: boolean;
  }): Routine {
    if (r.params && !validateRoutineParams(r.params)) {
      throw new Error(`invalid macro parameter contract for "${r.name}"`);
    }
    const now = new Date().toISOString();
    const existing = this.getRoutine(r.scope, r.name);
    const id = r.id ?? existing?.id ?? crypto.randomUUID();
    if (existing) {
      this.#db
        .prepare(
          `UPDATE routines SET kind = ?, params = ?, steps = ?, prompt = ?, schedule = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          r.kind,
          r.params ? JSON.stringify(r.params) : null,
          r.steps ?? null,
          r.prompt ?? null,
          r.schedule ?? null,
          (r.enabled ?? true) ? 1 : 0,
          now,
          id,
        );
      return {
        ...(existing as Routine),
        kind: r.kind,
        params: r.params ?? null,
        steps: r.steps ?? null,
        prompt: r.prompt ?? null,
        schedule: r.schedule ?? null,
        enabled: r.enabled ?? true,
        updatedAt: now,
      };
    }
    this.#db
      .prepare(
        `INSERT INTO routines (id, scope, name, kind, params, steps, prompt, schedule, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        r.scope,
        r.name,
        r.kind,
        r.params ? JSON.stringify(r.params) : null,
        r.steps ?? null,
        r.prompt ?? null,
        r.schedule ?? null,
        (r.enabled ?? true) ? 1 : 0,
        now,
        now,
      );
    return {
      id,
      scope: r.scope,
      name: r.name,
      kind: r.kind,
      params: r.params ?? null,
      steps: r.steps ?? null,
      prompt: r.prompt ?? null,
      schedule: r.schedule ?? null,
      enabled: r.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
    };
  }

  getRoutine(scope: string, name: string): Routine | null {
    const r = this.#db
      .prepare('SELECT * FROM routines WHERE scope = ? AND name = ?')
      .get(scope, name) as Record<string, string | number> | undefined;
    return r ? mapRoutine(r) : null;
  }

  listRoutines(scope?: string): Routine[] {
    const rows = (
      scope
        ? this.#db.prepare('SELECT * FROM routines WHERE scope = ? ORDER BY name').all(scope)
        : this.#db.prepare('SELECT * FROM routines ORDER BY scope, name').all()
    ) as Array<Record<string, string | number>>;
    return rows.map(mapRoutine);
  }

  deleteRoutine(scope: string, name: string): boolean {
    const r = this.#db
      .prepare('DELETE FROM routines WHERE scope = ? AND name = ?')
      .run(scope, name);
    return Number(r.changes) > 0;
  }

  markRoutineRun(scope: string, name: string): void {
    this.#db
      .prepare('UPDATE routines SET last_run_at = ? WHERE scope = ? AND name = ?')
      .run(new Date().toISOString(), scope, name);
  }

  // ---- kv -----------------------------------------------------------------

  kvGet(key: string): string | null {
    const r = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  kvSet(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(key, value, new Date().toISOString());
  }
}

/**
 * The params column is JSON this process wrote; a hand-edited or truncated row
 * still has to load, so anything unreadable or invalid maps to no contract. A
 * routine in the macro/ namespace with no valid contract is BLOCKED by every
 * caller (it is never replayed as a plain procedure).
 */
function parseRoutineParams(raw: string | number | null | undefined): RoutineParam[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    return validateRoutineParams(JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

function mapRoutine(r: Record<string, string | number>): Routine {
  return {
    id: String(r.id),
    scope: String(r.scope),
    name: String(r.name),
    kind: String(r.kind) as Routine['kind'],
    params: parseRoutineParams(r.params),
    steps: r.steps === null ? null : String(r.steps),
    prompt: r.prompt === null ? null : String(r.prompt),
    schedule: r.schedule === null ? null : String(r.schedule),
    enabled: Number(r.enabled) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastRunAt: r.last_run_at === null ? null : String(r.last_run_at),
  };
}

function mapIntent(r: Record<string, string | number>): PurchaseIntent {
  return {
    id: String(r.id),
    conversationId: r.conversation_id === null ? null : String(r.conversation_id),
    vendor: String(r.vendor),
    summary: String(r.summary),
    amountCents: Number(r.amount_cents),
    currency: String(r.currency),
    status: String(r.status) as PurchaseIntent['status'],
    reference: r.reference === null ? null : String(r.reference),
    detail: r.detail === null ? null : String(r.detail),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    expiresAt: String(r.expires_at),
  };
}
