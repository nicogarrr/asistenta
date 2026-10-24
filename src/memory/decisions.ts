/**
 * Decision ledger: the only producer of a workstream's "resuelto" text.
 *
 * A decision counts as resolved only when its quote is found, verbatim, inside
 * an authentic inbound message from an authorised user in the SAME thread. The
 * model chooses what to record, but it cannot make something resolved by
 * paraphrasing or inventing: the quote is checked against the message the
 * channel delivered, and the message id, author and date are kept.
 *
 * Tentative notes are stored and labelled, and never reach "resuelto". A
 * retracted or superseded entry leaves the prompt. A confirmed decision is a
 * fact about what the user said, NOT permission to execute anything: payment
 * and other gated actions keep their own approval.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkstreamStore } from './workstreams.js';

export interface AuthenticInbound {
  messageId: string;
  userId: string;
  text: string;
  receivedAt: string;
  authorised: boolean;
  /** Same thread key the workstream lives under. */
  scope: string;
}

export type DecisionStatus = 'confirmed' | 'tentative' | 'retracted' | 'superseded';

export interface Decision {
  id: string;
  scope: string;
  workstreamId: string;
  summary: string;
  quote: string | null;
  messageId: string | null;
  userId: string | null;
  receivedAt: string | null;
  status: DecisionStatus;
}

export type RecordResult = { ok: true; id: string } | { ok: false; reason: string };

const MIN_QUOTE = 4;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export class DecisionLedger {
  readonly #db: DatabaseSync;
  readonly #ws: WorkstreamStore;

  constructor(db: DatabaseSync, ws: WorkstreamStore) {
    this.#db = db;
    this.#ws = ws;
    db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY, scope TEXT, workstream_id TEXT, summary TEXT, quote TEXT,
      message_id TEXT, user_id TEXT, received_at TEXT, status TEXT, created_at INTEGER)`);
  }

  /** Confirmed only with a quote verified against the authentic inbound message. */
  recordConfirmed(
    workstreamId: string,
    summary: string,
    quote: string,
    inbound: AuthenticInbound | undefined,
    supersedes?: string,
  ): RecordResult {
    const ws = this.#ws.read(workstreamId);
    if (!ws) return { ok: false, reason: 'no existe ese frente' };
    if (!inbound) return { ok: false, reason: 'sin mensaje auténtico del usuario' };
    if (inbound.scope !== ws.scope) return { ok: false, reason: 'otra conversación' };
    if (!inbound.authorised) return { ok: false, reason: 'autor no autorizado' };
    if (!summary.trim()) return { ok: false, reason: 'resumen vacío' };
    if (norm(quote).length < MIN_QUOTE) return { ok: false, reason: 'cita demasiado corta' };
    if (!norm(inbound.text).includes(norm(quote))) {
      return { ok: false, reason: 'la cita no aparece en el mensaje del usuario' };
    }
    if (supersedes) this.#setStatus(supersedes, ws.scope, 'superseded');
    const id = randomUUID();
    this.#insert(id, ws.scope, workstreamId, summary, quote, inbound, 'confirmed');
    this.sync(workstreamId);
    return { ok: true, id };
  }

  /** Tentative: stored and labelled, never shown as resolved. */
  recordTentative(workstreamId: string, summary: string): RecordResult {
    const ws = this.#ws.read(workstreamId);
    if (!ws) return { ok: false, reason: 'no existe ese frente' };
    if (!summary.trim()) return { ok: false, reason: 'resumen vacío' };
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO decisions (id, scope, workstream_id, summary, quote, message_id, user_id, received_at, status, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'tentative', ?)`,
      )
      .run(id, ws.scope, workstreamId, summary, Date.now());
    return { ok: true, id };
  }

  retract(id: string, scope: string): boolean {
    const row = this.#db
      .prepare('SELECT workstream_id FROM decisions WHERE id = ? AND scope = ?')
      .get(id, scope) as { workstream_id: string } | undefined;
    if (!row) return false;
    this.#setStatus(id, scope, 'retracted');
    this.sync(row.workstream_id);
    return true;
  }

  list(workstreamId: string, status?: DecisionStatus): Decision[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM decisions WHERE workstream_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at, rowid`,
      )
      .all(...(status ? [workstreamId, status] : [workstreamId])) as Array<
      Record<string, string | null>
    >;
    return rows.map((r) => ({
      id: r.id as string,
      scope: r.scope as string,
      workstreamId: r.workstream_id as string,
      summary: r.summary as string,
      quote: r.quote ?? null,
      messageId: r.message_id ?? null,
      userId: r.user_id ?? null,
      receivedAt: r.received_at ?? null,
      status: r.status as DecisionStatus,
    }));
  }

  /** Rewrites the workstream's "resuelto" from confirmed entries only. */
  sync(workstreamId: string): void {
    const confirmed = this.list(workstreamId, 'confirmed').map((d) => d.summary);
    this.#ws.update(workstreamId, { decisions: confirmed.length ? confirmed.join('; ') : null });
  }

  #setStatus(id: string, scope: string, status: DecisionStatus): void {
    this.#db
      .prepare('UPDATE decisions SET status = ? WHERE id = ? AND scope = ?')
      .run(status, id, scope);
  }

  #insert(
    id: string,
    scope: string,
    wsId: string,
    summary: string,
    quote: string,
    m: AuthenticInbound,
    status: DecisionStatus,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO decisions (id, scope, workstream_id, summary, quote, message_id, user_id, received_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scope,
        wsId,
        summary,
        quote,
        m.messageId,
        m.userId,
        m.receivedAt,
        status,
        Date.now(),
      );
  }
}
