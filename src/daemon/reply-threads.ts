import type { DatabaseSync } from 'node:sqlite';

/**
 * Qué hilo envió cada mensaje nuestro, guardado en disco.
 *
 * El mapa en memoria (`messageThread` en cli.ts) se vacía al reiniciar, y Asistenta
 * se reinicia sola al autoactualizarse: responder a una respuesta antigua caía en la
 * conversación principal. Aquí queda una fila por mensaje enviado (`<chatKey>:<id>`
 * → clave del hilo y su etiqueta), con tope de filas y de antigüedad para que no
 * crezca sin fin. Vive en memory.db (SQLite: escritura atómica y ya en la copia).
 */
export interface ReplyThread {
  threadKey: string;
  label?: string;
}

export interface ReplyThreadStoreOptions {
  /** Filas como mucho (las más antiguas se van). */
  maxRows?: number;
  /** Antigüedad máxima de una fila, en ms. */
  maxAgeMs?: number;
  now?: () => number;
}

export const REPLY_THREADS_MAX_ROWS = 5000;
export const REPLY_THREADS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Cada cuántas escrituras se poda (y una vez al abrir). */
const PRUNE_EVERY = 200;

export class ReplyThreadStore {
  readonly #db: DatabaseSync;
  readonly #maxRows: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #writes = 0;

  constructor(db: DatabaseSync, opts: ReplyThreadStoreOptions = {}) {
    this.#db = db;
    this.#maxRows = Math.max(1, Math.floor(opts.maxRows ?? REPLY_THREADS_MAX_ROWS));
    this.#maxAgeMs = Math.max(1, opts.maxAgeMs ?? REPLY_THREADS_MAX_AGE_MS);
    this.#now = opts.now ?? Date.now;
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS reply_threads (
         msg_key TEXT PRIMARY KEY,
         thread_key TEXT NOT NULL,
         label TEXT,
         at INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS reply_threads_at ON reply_threads(at);`,
    );
    this.prune();
  }

  set(msgKey: string, threadKey: string, label?: string): void {
    this.#db
      .prepare(
        `INSERT INTO reply_threads (msg_key, thread_key, label, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(msg_key) DO UPDATE SET thread_key = excluded.thread_key,
           label = excluded.label, at = excluded.at`,
      )
      .run(msgKey, threadKey, label ?? null, this.#now());
    this.#writes++;
    if (this.#writes % PRUNE_EVERY === 0) this.prune();
  }

  get(msgKey: string): ReplyThread | undefined {
    const row = this.#db
      .prepare('SELECT thread_key, label, at FROM reply_threads WHERE msg_key = ?')
      .get(msgKey) as { thread_key: string; label: string | null; at: number } | undefined;
    if (!row) return undefined;
    if (this.#now() - Number(row.at) > this.#maxAgeMs) return undefined;
    return row.label
      ? { threadKey: row.thread_key, label: row.label }
      : { threadKey: row.thread_key };
  }

  /** Quita lo caducado y, si sobran filas, las más antiguas. */
  prune(): void {
    this.#db.prepare('DELETE FROM reply_threads WHERE at < ?').run(this.#now() - this.#maxAgeMs);
    this.#db
      .prepare(
        `DELETE FROM reply_threads WHERE msg_key NOT IN
           (SELECT msg_key FROM reply_threads ORDER BY at DESC, rowid DESC LIMIT ?)`,
      )
      .run(this.#maxRows);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM reply_threads').get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }
}

/**
 * El mapa de siempre (en memoria, lo de este arranque) con copia en disco.
 *
 * `get` solo mira la memoria a propósito: quien pregunta «¿esta conversación ya
 * tiene ese mensaje en su transcripción?» (la cita de la respuesta) debe oír «no»
 * tras un reinicio. Para encontrar el hilo, `durable` mira también el disco.
 * Un fallo del disco nunca rompe el envío: se registra y sigue.
 */
export interface DurableMessageThread {
  get(key: string): string | undefined;
  set(key: string, threadKey: string): DurableMessageThread;
  durable(key: string): ReplyThread | undefined;
  /**
   * Un hilo retirado de memoria pierde su transcripción: sus entradas en memoria se
   * van (la cita vuelve a entrar al responderle) y el disco las conserva para
   * reconstruirlo.
   */
  forgetThread(threadKey: string): void;
}

export function durableMessageThread(
  memory: Map<string, string>,
  store: Pick<ReplyThreadStore, 'get' | 'set'> | undefined,
  opts: {
    labelOf?: (threadKey: string) => string | undefined;
    onError?: (err: unknown) => void;
  } = {},
): DurableMessageThread {
  const api: DurableMessageThread = {
    get: (key) => memory.get(key),
    set: (key, threadKey) => {
      memory.set(key, threadKey);
      try {
        store?.set(key, threadKey, opts.labelOf?.(threadKey));
      } catch (err) {
        opts.onError?.(err);
      }
      return api;
    },
    durable: (key) => {
      const live = memory.get(key);
      if (live) return { threadKey: live, label: opts.labelOf?.(live) };
      try {
        return store?.get(key);
      } catch (err) {
        opts.onError?.(err);
        return undefined;
      }
    },
    forgetThread: (threadKey) => {
      for (const [key, value] of memory) if (value === threadKey) memory.delete(key);
    },
  };
  return api;
}

/** Abre el almacén; si la base falla, sigue sin copia en disco (como antes). */
export function openReplyThreadStore(
  db: DatabaseSync,
  onError: (err: unknown) => void,
  opts?: ReplyThreadStoreOptions,
): ReplyThreadStore | undefined {
  try {
    return new ReplyThreadStore(db, opts);
  } catch (err) {
    onError(err);
    return undefined;
  }
}
