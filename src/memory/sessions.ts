/**
 * Episodic memory: one row per conversation (a "session"), its turns appended
 * in order, and a summary written when the session ends.
 *
 * Why this is SQLite and not the markdown files of `src/memory.ts`: turns are
 * written on every message and searched on demand, which is exactly the access
 * pattern a database is for. Long-term memory answers "what do I know about
 * this user"; this answers "what happened, and where have we seen this before".
 *
 * Why the FTS5 index is external-content over `sessions` and `session_turns`: the index
 * is derived state. Keeping the text only in the base tables means the index can be
 * dropped and rebuilt, and it can never hold a title or summary or a turn the base
 * tables lost. The triggers are the price of that: every write fans out to the index
 * immediately, so a crash cannot leave the two out of sync for long.
 *
 * Why the turns are indexed and not only the session header: the question this feature
 * exists for is "¿qué hicimos con el gimnasio la semana pasada?", and the answer lives
 * in the messages. A title like "Seguimiento semanal" and a summary that never mentions
 * the gym would make `search('gimnasio')` miss exactly the session the user is asking
 * about. So search matches the header and the body together, and reports the turn that
 * matched as the snippet: that is the sentence the reader needs.
 *
 * Why search degrades to LIKE instead of failing: FTS5 is a compile-time SQLite
 * option and some builds ship without it. An agent that cannot search its own
 * history is worse than one that searches it slowly.
 *
 * Why MATCH input is quoted token by token: the query comes from a human and
 * FTS5 has its own query syntax. `NEAR(` or an unbalanced quote must be a
 * literal search, not a parse error in the middle of a turn.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** One conversation. `endedAt` stays null while the session is still open. */
export interface Session {
  id: string;
  scope: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
}

/**
 * A search hit. `snippet` is the matching window of text: the turn that matched when
 * the hit came from the body, the summary or title otherwise.
 */
export interface SessionExport {
  session: Session;
  turns: Array<{ role: string; text: string; at: number }>;
}

export interface SessionHit {
  sessionId: string;
  title: string;
  summary: string;
  snippet: string;
  at: number;
}

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  scope      TEXT,
  title      TEXT,
  started_at INTEGER,
  ended_at   INTEGER,
  summary    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope, started_at);

CREATE TABLE IF NOT EXISTS session_turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  role       TEXT,
  text       TEXT,
  at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_turns_session ON session_turns(session_id, at);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  title,
  summary,
  content='sessions',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS sessions_fts_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO sessions_fts (rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_delete AFTER DELETE ON sessions BEGIN
  INSERT INTO sessions_fts (sessions_fts, rowid, title, summary)
  VALUES ('delete', old.rowid, old.title, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS sessions_fts_update AFTER UPDATE ON sessions BEGIN
  INSERT INTO sessions_fts (sessions_fts, rowid, title, summary)
  VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO sessions_fts (rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS session_turns_fts USING fts5(
  text,
  content='session_turns',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS session_turns_fts_insert AFTER INSERT ON session_turns BEGIN
  INSERT INTO session_turns_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS session_turns_fts_delete AFTER DELETE ON session_turns BEGIN
  INSERT INTO session_turns_fts (session_turns_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS session_turns_fts_update AFTER UPDATE ON session_turns BEGIN
  INSERT INTO session_turns_fts (session_turns_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
  INSERT INTO session_turns_fts (rowid, text) VALUES (new.id, new.text);
END;
`;

type SessionRow = {
  id: string;
  scope: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
};

type HitRow = {
  id: string;
  title: string | null;
  summary: string | null;
  snippet: string | null;
  started_at: number;
};

/** One row per FTS source: `src` 0 is the session header, 1 is a matching turn. */
type FtsRow = HitRow & { src: number };

/** The LIKE fallback row: `turn` is the first matching turn text, when there is one. */
type LikeRow = {
  id: string;
  title: string | null;
  summary: string | null;
  started_at: number;
  turn: string | null;
};

function mapSession(r: SessionRow): Session {
  return {
    id: String(r.id),
    scope: r.scope ?? '',
    title: r.title ?? '',
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    summary: r.summary ?? null,
  };
}

function mapHit(r: HitRow): SessionHit {
  return {
    sessionId: String(r.id),
    title: r.title ?? '',
    summary: r.summary ?? '',
    snippet: r.snippet ?? '',
    at: Number(r.started_at),
  };
}

/** `%`, `_` and `\` are LIKE wildcards; a query containing one must stay literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Wrap every whitespace-separated token in double quotes so the query is a
 * conjunction of literal phrases. Commas and parens inside a quoted phrase are
 * plain text to FTS5.
 */
function matchQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ');
}

/** Window around the match, so the LIKE path returns something snippet-shaped. */
function windowSnippet(text: string, needle: string): string {
  const lowered = needle.toLowerCase();
  const at = text.toLowerCase().indexOf(lowered);
  if (at < 0) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + needle.length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function likeSnippet(title: string | null, summary: string | null, needle: string): string {
  const lowered = needle.toLowerCase();
  let text = summary ?? title ?? '';
  if (summary?.toLowerCase().includes(lowered)) text = summary;
  else if (title?.toLowerCase().includes(lowered)) text = title;
  return windowSnippet(text, needle);
}

/**
 * Group the two FTS sources by session. Order keeps the best-ranked row's position;
 * the snippet prefers a turn match, because the sentence that actually contains the
 * query is what the reader wants to see.
 */
function mergeFtsRows(rows: FtsRow[], limit: number): SessionHit[] {
  const bySession = new Map<string, { hit: SessionHit; fromTurn: boolean }>();
  for (const row of rows) {
    const id = String(row.id);
    const fromTurn = row.src === 1;
    const prev = bySession.get(id);
    if (!prev) {
      bySession.set(id, { hit: mapHit(row), fromTurn });
      continue;
    }
    if (fromTurn && !prev.fromTurn) {
      bySession.set(id, {
        hit: { ...prev.hit, snippet: row.snippet ?? prev.hit.snippet },
        fromTurn,
      });
    }
  }
  return [...bySession.values()].slice(0, limit).map((entry) => entry.hit);
}

export class SessionStore {
  /** False when this SQLite build has no FTS5: `search` then falls back to LIKE. */
  readonly ftsAvailable: boolean;

  readonly #db: DatabaseSync;

  constructor(opts: { db: DatabaseSync }) {
    this.#db = opts.db;
    this.#db.exec(BASE_SCHEMA);
    this.ftsAvailable = false;
    try {
      this.#db.exec(FTS_SCHEMA);
      this.ftsAvailable = true;
    } catch {
      // No FTS5 compiled into this SQLite, or the virtual table cannot be
      // created here. Not fatal: `search` uses LIKE over title, summary and
      // turns instead.
    }
    if (this.ftsAvailable) {
      try {
        // Backfill both indexes from their content tables. A database written by an
        // older schema (no turns index) or restored from a dump holds rows the
        // triggers never saw, and `rebuild` is idempotent, so running it on every
        // open is the cheap way to keep the index honest.
        this.#db.exec(
          `INSERT INTO sessions_fts(sessions_fts) VALUES ('rebuild');
           INSERT INTO session_turns_fts(session_turns_fts) VALUES ('rebuild');`,
        );
      } catch {
        // A build without the 'rebuild' command keeps the trigger-maintained index.
      }
    }
    try {
      // Provenance column: who opened the session, recorded at write time.
      // Databases written before it existed get it here; their rows predate
      // goal ticks entirely (capability shipped together), so 'human' is true.
      this.#db.exec("ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'human'");
    } catch {
      /* already there */
    }
  }

  begin(scope: string, title: string, origin: 'human' | 'goal-tick' = 'human'): string {
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO sessions (id, scope, title, started_at, ended_at, summary, origin) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(id, scope, title, Date.now(), origin);
    return id;
  }

  addTurn(sessionId: string, role: string, text: string): void {
    this.#db
      .prepare('INSERT INTO session_turns (session_id, role, text, at) VALUES (?, ?, ?, ?)')
      .run(sessionId, role, text, Date.now());
  }

  /**
   * Whether a HUMAN turn opened on this scope after `sinceMs`. Provenance is
   * explicit (the origin column recorded at write time), never inferred from
   * a free-form title: a person may well start a message with "[objetivo]".
   */
  hasHumanTurnSince(scope: string, sinceMs: number): boolean {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE scope = ? AND started_at > ? AND origin = 'human'`,
      )
      .get(scope, sinceMs) as { n: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  }

  /** Closing writes the summary, which is what later searches and prompts use. */
  end(sessionId: string, summary: string): void {
    this.#db
      .prepare('UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?')
      .run(Date.now(), summary, sessionId);
  }

  search(query: string, scope?: string, limit = 5): SessionHit[] {
    const needle = query.trim();
    if (!needle) return [];
    const cap = Math.max(1, Math.floor(limit));
    if (this.ftsAvailable) {
      try {
        return this.#searchFts(needle, scope, cap);
      } catch {
        // A MATCH that still throws (odd tokens, corrupt index) must not kill
        // the turn: the LIKE path answers the same question, just slower.
      }
    }
    return this.#searchLike(needle, scope, cap);
  }

  /** Most recent first. `rowid DESC` breaks ties within the same millisecond. */
  recent(scope?: string, limit = 10): Session[] {
    const cap = Math.max(1, Math.floor(limit));
    const where = scope === undefined ? '' : ' WHERE scope = ?';
    const params: Array<string | number> = [];
    if (scope !== undefined) params.push(scope);
    params.push(cap);
    const rows = this.#db
      .prepare(
        `SELECT id, scope, title, started_at, ended_at, summary FROM sessions${where}
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as SessionRow[];
    return rows.map(mapSession);
  }

  /** Sesión completa (turnos incluidos) para exportar o auditar. No redacta: el
   *  llamador decide qué hacer con el texto (aquí va al propietario). */
  exportSession(sessionId: string): SessionExport | null {
    const row = this.#db
      .prepare('SELECT id, scope, title, started_at, ended_at, summary FROM sessions WHERE id = ?')
      .get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    const turns = this.#db
      .prepare('SELECT role, text, at FROM session_turns WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Array<{ role: string; text: string; at: number }>;
    return {
      session: mapSession(row),
      turns: turns.map((t) => ({ role: t.role, text: t.text, at: Number(t.at) })),
    };
  }

  /**
   * Matches on the session header and on the turns at once, grouped by session. A body
   * hit reports the turn that matched: that is the sentence the reader needs, not the
   * summary that may never mention the query.
   */
  #searchFts(needle: string, scope: string | undefined, limit: number): SessionHit[] {
    // `rank` is FTS5's own relevance: best match first, not newest first.
    const filter = scope === undefined ? '' : ' AND s.scope = ?';
    const q = matchQuery(needle);
    const params: Array<string | number> = [q];
    if (scope !== undefined) params.push(scope);
    params.push(q);
    if (scope !== undefined) params.push(scope);
    // Both sources can return the same session, so over-fetch a little: grouping
    // must not starve the result set.
    params.push(limit * 3);
    const rows = this.#db
      .prepare(
        `SELECT id, title, summary, started_at, snippet, src FROM (
           SELECT s.id AS id, s.title AS title, s.summary AS summary, s.started_at AS started_at,
                  snippet(sessions_fts, -1, '', '', '…', 10) AS snippet,
                  0 AS src, rank AS r
             FROM sessions_fts
             JOIN sessions s ON s.rowid = sessions_fts.rowid
            WHERE sessions_fts MATCH ?${filter}
           UNION ALL
           SELECT s.id AS id, s.title AS title, s.summary AS summary, s.started_at AS started_at,
                  snippet(session_turns_fts, -1, '', '', '…', 10) AS snippet,
                  1 AS src, rank AS r
             FROM session_turns_fts
             JOIN session_turns t ON t.id = session_turns_fts.rowid
             JOIN sessions s ON s.id = t.session_id
            WHERE session_turns_fts MATCH ?${filter}
            ORDER BY r
         ) LIMIT ?`,
      )
      .all(...params) as FtsRow[];
    return mergeFtsRows(rows, limit);
  }

  /**
   * The no-FTS5 path searches the same three places with LIKE: title, summary and the
   * turns of each session. The snippet still comes from the turn that matched when the
   * body is where the needle is.
   */
  #searchLike(needle: string, scope: string | undefined, limit: number): SessionHit[] {
    const like = `%${escapeLike(needle)}%`;
    const filter = scope === undefined ? '' : ' AND s.scope = ?';
    const params: Array<string | number> = [like, like, like, like];
    if (scope !== undefined) params.push(scope);
    params.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT s.id AS id, s.title AS title, s.summary AS summary, s.started_at AS started_at,
                (SELECT t.text FROM session_turns t
                  WHERE t.session_id = s.id AND t.text LIKE ? ESCAPE '\\'
                  ORDER BY t.id LIMIT 1) AS turn
           FROM sessions s
          WHERE (s.title LIKE ? ESCAPE '\\'
              OR s.summary LIKE ? ESCAPE '\\'
              OR EXISTS (SELECT 1 FROM session_turns t
                          WHERE t.session_id = s.id AND t.text LIKE ? ESCAPE '\\'))${filter}
          ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`,
      )
      .all(...params) as LikeRow[];
    return rows.map((r) => ({
      sessionId: String(r.id),
      title: r.title ?? '',
      summary: r.summary ?? '',
      snippet: r.turn ? windowSnippet(r.turn, needle) : likeSnippet(r.title, r.summary, needle),
      at: Number(r.started_at),
    }));
  }
}
