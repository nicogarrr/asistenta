/**
 * Universal errands (capability 3, GESTOR UNIVERSAL): Nico says "hazme X en
 * esta web/programa", the daemon shows him a plan whose every step declares
 * its effect class, and only his explicit yes starts the work - `ejecutar` is
 * hardcoded as an always-ask in the Gate, the same treatment as activating a
 * goal. The errand then runs live in its own chat with the ordinary tools.
 *
 * Why durable rows: an active gestión decides what the Gate asks about (the
 * class of the current step), and a daemon restart must not silently drop
 * that guard - the per-thread Gate predicate reads this table live.
 *
 * Why per-scope caps: a gestión is foreground work in one chat. One active
 * per chat keeps "the current step" unambiguous for the Gate check and for
 * Nico; the proposed waiting room is capped so it cannot pile up.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { EFFECT_LABEL, type EffectClass, effectCovered } from './effects.js';

export type GestionStatus = 'proposed' | 'active' | 'done' | 'cancelled';

export interface GestionStep {
  text: string;
  effect: EffectClass;
  done: boolean;
  note?: string;
}

export interface LedgerEntry {
  /** 1-based step number, matching the plan Nico approved. */
  step: number;
  note: string;
  at: string;
}

export interface Gestion {
  id: string;
  /** thread.key of the owning chat: scope comes from the caller, never from the model. */
  scope: string;
  title: string;
  /** Nico's own words, verbatim: execution never guesses intent from a summary. */
  encargo: string;
  plan: GestionStep[];
  status: GestionStatus;
  /** 0-based index of the step being worked; plan.length when all are done. */
  currentStep: number;
  /** What happened, in order: the audit trail of the approved plan. */
  ledger: LedgerEntry[];
  createdAt: string;
  updatedAt: string;
}

/** One active errand per chat: foreground work, one current step, no ambiguity. */
export const MAX_ACTIVE_GESTIONES_PER_SCOPE = 1;
/** Proposed errands wait for a human yes; cap the waiting room so it cannot pile up. */
export const MAX_PROPOSED_GESTIONES = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gestiones (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  title         TEXT NOT NULL,
  encargo       TEXT NOT NULL,
  plan          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('proposed','active','done','cancelled')),
  current_step  INTEGER NOT NULL DEFAULT 0,
  ledger        TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gestiones_scope ON gestiones(scope, status);
`;

type GestionRow = {
  id: string;
  scope: string;
  title: string;
  encargo: string;
  plan: string;
  status: string;
  current_step: number;
  ledger: string;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, scope, title, encargo, plan, status, current_step, ledger, created_at, updated_at';

function mapGestion(r: GestionRow): Gestion {
  let plan: GestionStep[] = [];
  try {
    const parsed = JSON.parse(r.plan) as unknown;
    if (Array.isArray(parsed)) plan = parsed as GestionStep[];
  } catch {
    /* a corrupt plan row reads as an empty plan, never as a crash */
  }
  let ledger: LedgerEntry[] = [];
  try {
    const parsed = JSON.parse(r.ledger) as unknown;
    if (Array.isArray(parsed)) ledger = parsed as LedgerEntry[];
  } catch {
    /* same for the ledger */
  }
  return {
    id: r.id,
    scope: r.scope,
    title: r.title,
    encargo: r.encargo,
    plan,
    status: r.status as GestionStatus,
    currentStep: Number(r.current_step),
    ledger,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class GestorStore {
  readonly #db: DatabaseSync;

  constructor(opts: { db: DatabaseSync }) {
    this.#db = opts.db;
    this.#db.exec(SCHEMA);
  }

  #count(scope: string, status: GestionStatus): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM gestiones WHERE scope = ? AND status = ?')
      .get(scope, status) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  propose(input: { scope: string; title: string; encargo: string; plan: GestionStep[] }): Gestion {
    if (this.#count(input.scope, 'proposed') >= MAX_PROPOSED_GESTIONES) {
      throw new Error(
        `Ya hay ${MAX_PROPOSED_GESTIONES} gestiones propuestas esperando respuesta. Ejecuta o cancela alguna antes de preparar otra.`,
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO gestiones (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'proposed', 0, '[]', ?, ?)`,
      )
      .run(id, input.scope, input.title, input.encargo, JSON.stringify(input.plan), now, now);
    const gestion = this.read(id);
    if (!gestion) throw new Error('la gestión recién propuesta no se puede leer');
    return gestion;
  }

  /** proposed -> active. The only door in, and one active per chat at most. */
  start(id: string): void {
    const gestion = this.#mustRead(id);
    if (gestion.status !== 'proposed') {
      throw new Error(
        `Solo se ejecuta una gestión propuesta; "${gestion.title}" está ${gestion.status}.`,
      );
    }
    if (this.#count(gestion.scope, 'active') >= MAX_ACTIVE_GESTIONES_PER_SCOPE) {
      throw new Error(
        'Ya hay una gestión activa en este chat. Termínala o cancélala antes de ejecutar otra.',
      );
    }
    this.#set(id, { status: 'active', current_step: '0' });
  }

  /**
   * Marks a step done and appends to the ledger. current_step advances to the
   * first step still pending (or plan.length when none is), so the Gate's
   * effect guard always compares against the step actually being worked.
   */
  recordStep(id: string, stepIdx: number, note: string): void {
    const gestion = this.#mustRead(id);
    if (gestion.status !== 'active') {
      throw new Error(
        `Solo se avanza una gestión activa; "${gestion.title}" está ${gestion.status}.`,
      );
    }
    if (!Number.isInteger(stepIdx) || stepIdx < 0 || stepIdx >= gestion.plan.length) {
      throw new Error(`paso debe ser un número entero entre 1 y ${gestion.plan.length}.`);
    }
    if (gestion.plan[stepIdx]?.done) {
      throw new Error(
        `El paso ${stepIdx + 1} ya estaba marcado como hecho; no lo registro dos veces.`,
      );
    }
    const plan = gestion.plan.map((s, i) =>
      i === stepIdx ? { ...s, done: true, note: note || s.note } : s,
    );
    const next = plan.findIndex((s) => !s.done);
    const ledger = [...gestion.ledger, { step: stepIdx + 1, note, at: new Date().toISOString() }];
    this.#set(id, {
      plan: JSON.stringify(plan),
      current_step: String(next === -1 ? plan.length : next),
      ledger: JSON.stringify(ledger),
    });
  }

  /** active -> done. The tool checks every step is done before calling this. */
  complete(id: string): void {
    const gestion = this.#mustRead(id);
    if (gestion.status !== 'active') {
      throw new Error(`Solo se completa una gestión activa; está ${gestion.status}.`);
    }
    this.#set(id, { status: 'done' });
  }

  cancel(id: string): void {
    const gestion = this.#mustRead(id);
    if (gestion.status === 'done') {
      throw new Error('Una gestión terminada no se cancela; ya está hecha.');
    }
    this.#set(id, { status: 'cancelled' });
  }

  read(id: string): Gestion | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM gestiones WHERE id = ?`).get(id) as
      | GestionRow
      | undefined;
    return row ? mapGestion(row) : null;
  }

  /** The one active errand of a chat, for the Gate predicate and the tool defaults. */
  activeForScope(scope: string): Gestion | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM gestiones WHERE scope = ? AND status = 'active'`)
      .get(scope) as GestionRow | undefined;
    return row ? mapGestion(row) : null;
  }

  list(scope?: string): Gestion[] {
    const rows = (
      scope === undefined
        ? this.#db.prepare(`SELECT ${COLUMNS} FROM gestiones ORDER BY updated_at DESC`).all()
        : this.#db
            .prepare(`SELECT ${COLUMNS} FROM gestiones WHERE scope = ? ORDER BY updated_at DESC`)
            .all(scope)
    ) as GestionRow[];
    return rows.map(mapGestion);
  }

  #mustRead(id: string): Gestion {
    const gestion = this.read(id);
    if (!gestion) throw new Error(`No existe la gestión: ${id}`);
    return gestion;
  }

  #set(id: string, fields: Record<string, string>): void {
    const sets = Object.keys(fields)
      .map((c) => `${c} = ?`)
      .join(', ');
    this.#db
      .prepare(`UPDATE gestiones SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), new Date().toISOString(), id);
  }
}

/**
 * The Gate predicate's question, in one function so the wording is tested
 * once. null when nothing forces an ask; otherwise the reason Nico reads.
 * Fail-closed by construction: an unprovable call class (null) asks whatever
 * the step declares, and an active gestión with no valid current step - plan
 * finished but not closed, or a corrupt row - asks for anything with a world
 * effect. Reading and the gestion tool itself stay free in that state so the
 * model can still close the gestión.
 */
export function effectOverrideReason(
  gestion: Gestion | null,
  callClass: EffectClass | null,
): string | null {
  if (!gestion || gestion.status !== 'active') return null;
  const step = gestion.plan[gestion.currentStep];
  if (!step) {
    if (callClass === 'lee') return null;
    return `gestión "${gestion.title}": plan completado sin cerrar (o estado corrupto); las acciones con efecto preguntan hasta gestion:completar`;
  }
  if (callClass === null) {
    return `gestión "${gestion.title}": no puedo probar la clase de efecto de esta acción (el paso ${gestion.currentStep + 1} se aprobó como [${EFFECT_LABEL[step.effect]}])`;
  }
  if (effectCovered(callClass, step.effect)) return null;
  return `gestión "${gestion.title}": el paso ${gestion.currentStep + 1} se aprobó como [${EFFECT_LABEL[step.effect]}] y esta acción es [${EFFECT_LABEL[callClass]}]`;
}
