/**
 * Episodic memory: one row per conversation (a "session"), its turns appended
 * in order, and a summary written when the session ends.
 *
 * Why this is SQLite and not the markdown files of `src/memory.ts`: turns are
 * written on every message and searched on demand, which is exactly the access
 * pattern a database is for. Long-term memory answers "what do I know about
 * this user"; this answers "what happened, and where have we seen this before".
 *
 * Why the FTS5 index is external-content over `sessions`: the index is derived
 * state. Keeping the text only in `sessions` means the index can be dropped and
 * rebuilt, and it can never hold a title or summary the base table lost. The
 * triggers are the price of that: every write to `sessions` fans out to the
 * index immediately, so a crash cannot leave the two out of sync for long.
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

/** A search hit. `snippet` is the matching window of text, not the full summary. */
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
function likeSnippet(title: string | null, summary: string | null, needle: string): string {
  const lowered = needle.toLowerCase();
  let text = summary ?? title ?? '';
  if (summary?.toLowerCase().includes(lowered)) text = summary;
  else if (title?.toLowerCase().includes(lowered)) text = title;
  const at = text.toLowerCase().indexOf(lowered);
  if (at < 0) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + needle.length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
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
      // created here. Not fatal: `search` uses LIKE over title/summary instead.
    }
  }

  begin(scope: string, title: string): string {
    const id = randomUUID();
    this.#db
      .prepare(
        'INSERT INTO sessions (id, scope, title, started_at, ended_at, summary) VALUES (?, ?, ?, ?, NULL, NULL)',
      )
      .run(id, scope, title, Date.now());
    return id;
  }

  addTurn(sessionId: string, role: string, text: string): void {
    this.#db
      .prepare('INSERT INTO session_turns (session_id, role, text, at) VALUES (?, ?, ?, ?)')
      .run(sessionId, role, text, Date.now());
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

  #searchFts(needle: string, scope: string | undefined, limit: number): SessionHit[] {
    // `rank` is FTS5's own relevance: best match first, not newest first.
    const filter = scope === undefined ? '' : ' AND s.scope = ?';
    const params: Array<string | number> = [matchQuery(needle)];
    if (scope !== undefined) params.push(scope);
    params.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT s.id AS id, s.title AS title, s.summary AS summary, s.started_at AS started_at,
                snippet(sessions_fts, -1, '', '', '…', 10) AS snippet
         FROM sessions_fts
         JOIN sessions s ON s.rowid = sessions_fts.rowid
         WHERE sessions_fts MATCH ?${filter}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as HitRow[];
    return rows.map(mapHit);
  }

  #searchLike(needle: string, scope: string | undefined, limit: number): SessionHit[] {
    const like = `%${escapeLike(needle)}%`;
    const filter = scope === undefined ? '' : ' AND scope = ?';
    const params: Array<string | number> = [like, like];
    if (scope !== undefined) params.push(scope);
    params.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT id, title, summary, started_at FROM sessions
         WHERE (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')${filter}
         ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as SessionRow[];
    return rows.map((r) => ({
      sessionId: String(r.id),
      title: r.title ?? '',
      summary: r.summary ?? '',
      snippet: likeSnippet(r.title, r.summary, needle),
      at: Number(r.started_at),
    }));
  }
}
