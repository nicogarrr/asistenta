/**
 * La bandeja en SQLite (`<estado>/bandeja.db`, con WAL y busy_timeout como el resto
 * de bases del daemon). Una fila por cosa guardada; `day` es el día local al que
 * pertenece (cambia con «⏭️ Mañana»), `state` lo que hizo Nico con ella y `status`
 * cómo va su procesado.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openSqlite } from '../sqlite.js';
import { type BandejaKind, type CaptureCandidate, canonicalKey } from './captura.js';

export type Veredicto = 'imprescindible' | 'ideas' | 'paja';
export type Estado = 'pendiente' | 'visto' | 'descartado';
export type Procesado = 'nuevo' | 'procesando' | 'listo' | 'error';

export interface Goodreads {
  ok: boolean;
  /** Media de Goodreads (0–5) y número de valoraciones, si se encontró. */
  rating?: number;
  ratings?: number;
  url?: string;
  /** Por qué no hay nota (bloqueado, no encontrado…). */
  reason?: string;
}

export interface BandejaExtra {
  author?: string;
  /**
   * En qué se basó el veredicto: la transcripción entera, o solo la descripción o la
   * ficha (sin transcripción), que la ficha dice para que Nico lo sepa.
   */
  basis?: 'transcripcion' | 'descripcion' | 'ficha' | 'texto' | 'captura';
  /** Por qué no hubo transcripción (cuando `basis` es descripción o ficha). */
  basisReason?: string;
  /**
   * Transcripción a medias: el tope de tiempo cortó el whisper y solo se oyeron los primeros
   * N min (la nota y el Kindle son de esa parte, y se dice).
   */
  heardMin?: number;
  /** Un dato público real al lado de nuestra nota (visualizaciones de YouTube…). */
  publicRating?: string;
  /** PDF original que ofrece el autor o la página (se adjunta tal cual, nunca se rehace). */
  pdfUrl?: string;
  /** Otro enlace al contenido completo (la versión en YouTube de un podcast, Open Library). */
  altUrl?: string;
  /** Sitio de origen legible («YouTube», «X», «elconfidencial.com»). */
  source?: string;
  goodreads?: Goodreads;
  /** Temas de Nico que toca (de «Tus temas»). */
  tags?: string[];
  pages?: number;
  year?: number;
}

export interface BandejaItem {
  id: number;
  chatId: string;
  kind: BandejaKind;
  url: string | null;
  title: string | null;
  note: string | null;
  fileId: string | null;
  fileName: string | null;
  mimeType: string | null;
  status: Procesado;
  error: string | null;
  verdict: Veredicto | null;
  score: number | null;
  reason: string | null;
  ideas: string[];
  /** Minutos que cuesta verlo/leerlo entero (estimado), y su etiqueta («23 min», «17 págs»). */
  costMin: number | null;
  costLabel: string | null;
  extra: BandejaExtra;
  state: Estado;
  createdAt: string;
  processedAt: string | null;
  day: string;
  /** Veces que ha pasado al día siguiente sin verse. */
  carried: number;
  digestedAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  url          TEXT,
  url_key      TEXT,
  title        TEXT,
  note         TEXT,
  file_id      TEXT,
  file_name    TEXT,
  mime_type    TEXT,
  status       TEXT NOT NULL DEFAULT 'nuevo',
  error        TEXT,
  verdict      TEXT,
  score        INTEGER,
  reason       TEXT,
  ideas        TEXT,
  cost_min     REAL,
  cost_label   TEXT,
  extra        TEXT,
  state        TEXT NOT NULL DEFAULT 'pendiente',
  created_at   TEXT NOT NULL,
  processed_at TEXT,
  day          TEXT NOT NULL,
  carried      INTEGER NOT NULL DEFAULT 0,
  digested_at  TEXT
);
CREATE INDEX IF NOT EXISTS items_day ON items (chat_id, day);
CREATE INDEX IF NOT EXISTS items_key ON items (chat_id, url_key);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS texts (
  item_id INTEGER PRIMARY KEY,
  body    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS msgs (
  chat_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  item_id    INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
`;

/** Tope del texto entero guardado por cosa (una transcripción de 4 h son ~250 000 caracteres). */
export const MAX_STORED_TEXT = 2_000_000;

type Row = Record<string, string | number | null>;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function mapRow(r: Row): BandejaItem {
  const ideas = parseJson<unknown>(r.ideas, []);
  return {
    id: Number(r.id),
    chatId: String(r.chat_id),
    kind: String(r.kind) as BandejaKind,
    url: str(r.url),
    title: str(r.title),
    note: str(r.note),
    fileId: str(r.file_id),
    fileName: str(r.file_name),
    mimeType: str(r.mime_type),
    status: String(r.status) as Procesado,
    error: str(r.error),
    verdict: (str(r.verdict) as Veredicto | null) ?? null,
    score: r.score === null || r.score === undefined ? null : Number(r.score),
    reason: str(r.reason),
    ideas: Array.isArray(ideas) ? ideas.map(String) : [],
    costMin: r.cost_min === null || r.cost_min === undefined ? null : Number(r.cost_min),
    costLabel: str(r.cost_label),
    extra: parseJson<BandejaExtra>(r.extra, {}),
    state: String(r.state) as Estado,
    createdAt: String(r.created_at),
    processedAt: str(r.processed_at),
    day: String(r.day),
    carried: Number(r.carried ?? 0),
    digestedAt: str(r.digested_at),
  };
}

export interface ProcessResult {
  title?: string | null;
  /**
   * El texto entero que se leyó (la transcripción, el post, el artículo), para «📖 Al
   * Kindle» sin volver a transcribir. No va en `extra`: se guarda aparte (tabla texts).
   */
  body?: string;
  verdict: Veredicto | null;
  score: number | null;
  reason: string | null;
  ideas: string[];
  costMin: number | null;
  costLabel: string | null;
  extra: BandejaExtra;
}

export class BandejaStore {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.#db = openSqlite(file, { wal: true });
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Guarda una cosa. Si el mismo enlace ya está pendiente en este chat, no se
   * duplica: devuelve la que había con `dup: true`.
   */
  add(
    chatId: string,
    c: CaptureCandidate,
    now: Date,
    day: string,
  ): { item: BandejaItem; dup: boolean } {
    const key = c.url ? canonicalKey(c.url) : null;
    if (key) {
      const prev = this.findPendingByKey(chatId, key);
      if (prev) return { item: prev, dup: true };
    }
    // «Post de @usuario» leído en una captura: si ya hay un post de X de esa cuenta
    // pendiente (Nico mandó también el enlace), es el mismo.
    const xUser =
      !c.url && c.kind === 'texto' ? /^Post de @(\w{1,30})/.exec(c.title ?? '')?.[1] : undefined;
    if (xUser) {
      const prev = this.#db
        .prepare(
          "SELECT * FROM items WHERE chat_id = ? AND kind = 'x' AND state = 'pendiente' AND lower(url) LIKE ? ORDER BY id LIMIT 1",
        )
        .get(chatId, `%/${xUser.toLowerCase()}/status/%`) as Row | undefined;
      if (prev) return { item: mapRow(prev), dup: true };
    }
    const res = this.#db
      .prepare(
        `INSERT INTO items (chat_id, kind, url, url_key, title, note, file_id, file_name, mime_type, created_at, day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chatId,
        c.kind,
        c.url ?? null,
        key,
        c.title ?? null,
        c.note ?? null,
        c.fileId ?? null,
        c.fileName ?? null,
        c.mimeType ?? null,
        now.toISOString(),
        day,
      );
    const item = this.get(Number(res.lastInsertRowid));
    if (!item) throw new Error('bandeja: no se guardó');
    return { item, dup: false };
  }

  /** Lo mismo (misma clave canónica) aún pendiente en este chat, salvo `exceptId`. */
  findPendingByKey(chatId: string, key: string, exceptId = 0): BandejaItem | null {
    const r = this.#db
      .prepare(
        "SELECT * FROM items WHERE chat_id = ? AND url_key = ? AND state = 'pendiente' AND id != ? ORDER BY id LIMIT 1",
      )
      .get(chatId, key, exceptId) as Row | undefined;
    return r ? mapRow(r) : null;
  }

  /** Pone el enlace a una cosa que llegó sin él (un vídeo visto en una captura). */
  setUrl(id: number, url: string): void {
    this.#db
      .prepare('UPDATE items SET url = ?, url_key = ? WHERE id = ?')
      .run(url, canonicalKey(url), id);
  }

  /** Cierra una cosa sin veredicto (repetida, o una captura desglosada en varias). */
  closeAs(id: number, reason: string): void {
    this.#db
      .prepare("UPDATE items SET state = 'descartado', status = 'listo', error = ? WHERE id = ?")
      .run(reason, id);
  }

  get(id: number): BandejaItem | null {
    const r = this.#db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
    return r ? mapRow(r) : null;
  }

  /** Las de un día (las descartadas no). */
  ofDay(chatId: string, day: string): BandejaItem[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM items WHERE chat_id = ? AND day = ? AND state != 'descartado' ORDER BY id",
        )
        .all(chatId, day) as Row[]
    ).map(mapRow);
  }

  countDay(chatId: string, day: string): number {
    const r = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM items WHERE chat_id = ? AND day = ? AND state != 'descartado'",
      )
      .get(chatId, day) as { n: number };
    return Number(r.n);
  }

  /** Todo lo pendiente de ver, de cualquier día. */
  pending(chatId: string): BandejaItem[] {
    return (
      this.#db
        .prepare("SELECT * FROM items WHERE chat_id = ? AND state = 'pendiente' ORDER BY id")
        .all(chatId) as Row[]
    ).map(mapRow);
  }

  /** Lo que aún no está procesado (para retomarlo al arrancar). */
  unprocessed(): BandejaItem[] {
    return (
      this.#db
        .prepare(
          "SELECT * FROM items WHERE status IN ('nuevo', 'procesando') AND state = 'pendiente' ORDER BY id",
        )
        .all() as Row[]
    ).map(mapRow);
  }

  /** Procesadas entre dos instantes (para el repaso semanal). */
  processedBetween(chatId: string, fromIso: string, toIso: string): BandejaItem[] {
    return (
      this.#db
        .prepare(
          'SELECT * FROM items WHERE chat_id = ? AND created_at >= ? AND created_at < ? ORDER BY id',
        )
        .all(chatId, fromIso, toIso) as Row[]
    ).map(mapRow);
  }

  setStatus(id: number, status: Procesado, error: string | null = null): void {
    this.#db.prepare('UPDATE items SET status = ?, error = ? WHERE id = ?').run(status, error, id);
  }

  saveResult(id: number, r: ProcessResult, now: Date): void {
    this.#db
      .prepare(
        `UPDATE items SET status = 'listo', error = NULL, title = COALESCE(?, title), verdict = ?, score = ?,
         reason = ?, ideas = ?, cost_min = ?, cost_label = ?, extra = ?, processed_at = ? WHERE id = ?`,
      )
      .run(
        r.title ?? null,
        r.verdict,
        r.score,
        r.reason,
        JSON.stringify(r.ideas),
        r.costMin,
        r.costLabel,
        JSON.stringify(r.extra),
        now.toISOString(),
        id,
      );
  }

  /** Guarda el texto entero de una cosa (para «📖 Al Kindle»). */
  saveText(id: number, body: string): void {
    this.#db
      .prepare(
        'INSERT INTO texts (item_id, body) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET body = excluded.body',
      )
      .run(id, body.slice(0, MAX_STORED_TEXT));
  }

  getText(id: number): string | null {
    const r = this.#db.prepare('SELECT body FROM texts WHERE item_id = ?').get(id) as
      | { body: string }
      | undefined;
    return r ? r.body : null;
  }

  /** Apunta que un mensaje de Telegram (el aviso, la ficha, el enlace de Nico) es de esta cosa. */
  linkMessage(chatId: string, messageId: string, itemId: number): void {
    this.#db
      .prepare(
        'INSERT INTO msgs (chat_id, message_id, item_id) VALUES (?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET item_id = excluded.item_id',
      )
      .run(chatId, messageId, itemId);
  }

  /** La cosa a la que pertenece un mensaje (para contestar «kindle» a ese mensaje). */
  itemForMessage(chatId: string, messageId: string): BandejaItem | null {
    const r = this.#db
      .prepare('SELECT item_id FROM msgs WHERE chat_id = ? AND message_id = ?')
      .get(chatId, messageId) as { item_id: number } | undefined;
    if (!r) return null;
    const item = this.get(Number(r.item_id));
    return item && item.chatId === chatId ? item : null;
  }

  setState(id: number, state: Estado): void {
    this.#db.prepare('UPDATE items SET state = ? WHERE id = ?').run(state, id);
  }

  /** «⏭️ Mañana» o arrastre de un 🔴 sin ver: pasa al día dado. */
  moveTo(id: number, day: string): void {
    this.#db.prepare('UPDATE items SET day = ?, carried = carried + 1 WHERE id = ?').run(day, id);
  }

  markDigested(ids: readonly number[], now: Date): void {
    const st = this.#db.prepare('UPDATE items SET digested_at = ? WHERE id = ?');
    for (const id of ids) st.run(now.toISOString(), id);
  }

  getMeta(key: string): string | null {
    const r = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else
      this.#db
        .prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
  }
}
