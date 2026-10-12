import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../log.js';
import { withTimeout } from '../utils.js';

/** Total document memory: every document the user forwards is text-extracted,
 * chunked, and indexed into a per-install sqlite FTS5 table so it can be
 * queried weeks later ("what did that contract say about...?"). Facts in the
 * classic memory store are things the model decided to keep; this store keeps
 * the source material itself, so the answer can quote the document instead of
 * a paraphrase nobody verified.
 *
 * Scope is per thread key, like the note memory: a document from one chat is
 * never surfaced in another, and the doc id itself is derived from the scope,
 * so the same file forwarded to two chats lives twice and deleting one never
 * touches the other.
 */

/** One forwarded document, as the channel describes it. */
export interface IncomingDocument {
  /** Telegram file_id or equivalent: only feeds the stable id, never a path. */
  fileId: string;
  /** File name the sender gave it ("contrato-alquiler.pdf"). */
  name?: string;
  mimeType?: string;
}

export interface IndexedDocument {
  docId: string;
  title: string;
  mimeType: string;
  chunks: number;
  /** Characters actually indexed — never the pre-truncation figure. */
  chars: number;
  /** True when part of the document did not fit (length or chunk cap). The
   * caller says "partially indexed" out loud; claiming full coverage of a
   * truncated contract is how someone misses the clause on the last page. */
  truncated: boolean;
}

export interface DocSearchHit {
  docId: string;
  title: string;
  /** ISO date of when it was indexed, so "the newer one" is answerable. */
  at: string;
  /** FTS5 snippet with the match wrapped in «» markers. */
  snippet: string;
  rank: number;
}

export interface DocMemoryOptions {
  /** Where the sqlite file lives. */
  dbPath: string;
  /** Where the extracted plain text is mirrored for later reindex. */
  directory: string;
  /** Injected clock, so retention tests do not sleep. */
  now?: () => number;
  /** Test-only: swap the pdfjs loader to exercise timeouts without a real PDF. */
  pdfjsLoader?: () => Promise<PdfjsLike>;
  /** Test-only: shorten the extraction budget so timeout tests stay fast. */
  extractTimeoutMs?: number;
}

/** A document bigger than this extracts more noise than signal in one pass. */
const MAX_TEXT_CHARS = 1_000_000;
/** Chunk size tuned so a chunk answers a question on its own. */
const CHUNK_CHARS = 1500;
const MAX_CHUNKS_PER_DOC = 400;
/** Extraction of one document never burns more than this, loading included. */
const EXTRACT_TIMEOUT_MS = 60_000;
const DEFAULT_SEARCH_LIMIT = 8;

/** The id is scoped on purpose: the same file_id forwarded to two chats must
 * produce two rows, or reindexing in one chat would silently delete the
 * other's memory. Telegram message ids are per-chat, so audio gets the same
 * treatment — unscoped, message 42 of chat B would evict message 42 of chat A.
 */
function docIdFor(scope: string, kind: string, ref: string): string {
  // JSON array as hash input: plain concatenation collides deterministically
  // ("a"+"doc"+"docx" === "adoc"+"doc"+"x") and a crafted scope could poison
  // another doc's id.
  return createHash('sha256')
    .update(JSON.stringify([scope, kind, ref]))
    .digest('hex')
    .slice(0, 16);
}

/** Split on paragraph boundaries, then hard-wrap whatever still overflows. */
export function chunkText(text: string, chunkChars = CHUNK_CHARS): string[] {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  let current = '';
  for (const para of cleaned.split(/\n{2,}/)) {
    if (para.length > chunkChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      for (let i = 0; i < para.length; i += chunkChars) chunks.push(para.slice(i, i + chunkChars));
      continue;
    }
    if (`${current}\n\n${para}`.trim().length > chunkChars && current.trim()) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** The slice of pdfjs we use, structural so tests can stub the loader. */
interface PdfjsLike {
  getDocument(opts: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
        cleanup(): void;
      }>;
    }>;
    destroy(): Promise<void>;
  };
}

async function defaultPdfjsLoader(): Promise<PdfjsLike> {
  return (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfjsLike;
}

/** pdfjs-dist is heavy (~5 MB), so it loads on first PDF, not at daemon start.
 * The timeout wraps the WHOLE job - loading and the per-page loop - and the
 * finally destroys the task either way: without the destroy, a hostile or
 * huge PDF keeps burning CPU after the caller has already given up. */
async function extractPdfText(
  bytes: Buffer,
  loader: () => Promise<PdfjsLike>,
  timeoutMs: number,
): Promise<string> {
  // One budget over EVERYTHING: loader, getDocument and the per-page loop. A
  // hang in any of them rejects at timeoutMs; nothing is awaited bare.
  let expired = false;
  let loadingTask: ReturnType<PdfjsLike['getDocument']> | undefined;
  const destroyTask = async (): Promise<void> => {
    // The destroy itself can hang on a stuck task, so it gets its own small
    // bound; its error is swallowed either way - it is cleanup, not result.
    const task = loadingTask;
    loadingTask = undefined;
    if (task) {
      await withTimeout(
        task.destroy().catch(() => {}),
        Math.min(10_000, timeoutMs),
        'pdf destroy timed out',
      ).catch(() => {});
    }
  };
  const work = (async () => {
    const pdfjs = await loader();
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    if (expired) {
      // The caller already gave up while the loader was in flight: kill the
      // task we just created so "no work after the rejection" stays true.
      await destroyTask();
      throw new Error('pdf extraction timed out');
    }
    const doc = await loadingTask.promise;
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
      page.cleanup();
    }
    return parts.join('\n\n');
  })();
  try {
    return await withTimeout(work, timeoutMs, 'pdf extraction timed out');
  } finally {
    expired = true;
    await destroyTask();
  }
}

/** What we know how to read today. Anything else is refused loudly at the
 * caller, because silently indexing zero bytes teaches the user to trust an
 * empty memory. */
export function canExtract(mimeType?: string): boolean {
  if (!mimeType) return false;
  const mime = mimeType.toLowerCase();
  return (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/markdown' ||
    mime === 'application/csv'
  );
}

export async function extractText(
  bytes: Buffer,
  mimeType?: string,
  pdfjsLoader?: () => Promise<PdfjsLike>,
  timeoutMs = EXTRACT_TIMEOUT_MS,
): Promise<string> {
  if (!mimeType) return '';
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf')
    return extractPdfText(bytes, pdfjsLoader ?? defaultPdfjsLoader, timeoutMs);
  if (canExtract(mimeType)) return bytes.toString('utf8');
  return '';
}

/** The sqlite FTS5 store. The scope argument the caller supplies is the ONLY
 * notion of audience: index and search must receive the same scope string
 * (the runtime passes the thread key on both paths) or nothing is findable.
 */
export class DocMemory {
  readonly #db: DatabaseSync;
  readonly #directory: string;
  readonly #now: () => number;
  readonly #pdfjsLoader?: () => Promise<PdfjsLike>;
  readonly #extractTimeoutMs: number;

  constructor(options: DocMemoryOptions) {
    mkdirSync(options.directory, { recursive: true });
    this.#db = new DatabaseSync(options.dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        doc_id TEXT PRIMARY KEY,
        chat_key TEXT NOT NULL,
        title TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        chars INTEGER NOT NULL,
        chunks INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks USING fts5(
        text,
        doc_id UNINDEXED,
        chat_key UNINDEXED,
        title UNINDEXED,
        at UNINDEXED
      );
    `);
    // DBs written before the truncated column existed keep their schema:
    // CREATE IF NOT EXISTS does not add columns, so migrate explicitly.
    const cols = this.#db.prepare('PRAGMA table_info(docs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'truncated')) {
      this.#db.exec('ALTER TABLE docs ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0');
    }
    this.#directory = options.directory;
    this.#now = options.now ?? Date.now;
    this.#pdfjsLoader = options.pdfjsLoader;
    this.#extractTimeoutMs = options.extractTimeoutMs ?? EXTRACT_TIMEOUT_MS;
  }

  /** Index one downloaded document under a scope. Returns null when there was
   * no readable text (scanned PDF, empty file) so the caller says so instead
   * of claiming a memory it does not have. Reindexing the same (scope, file)
   * replaces it in one transaction: readers never see a half-swapped doc. */
  async index(
    scope: string,
    doc: IncomingDocument,
    bytes: Buffer,
  ): Promise<IndexedDocument | null> {
    const extracted = await extractText(
      bytes,
      doc.mimeType,
      this.#pdfjsLoader,
      this.#extractTimeoutMs,
    );
    const sliced = extracted.slice(0, MAX_TEXT_CHARS);
    const allChunks = chunkText(sliced);
    if (!allChunks.length) return null;
    // Truncation is measured against the caps, never against the original
    // text: chunking normalizes whitespace, so comparing char counts would
    // flag perfectly whole documents as truncated.
    const truncated = extracted.length > sliced.length || allChunks.length > MAX_CHUNKS_PER_DOC;
    const chunks = allChunks.slice(0, MAX_CHUNKS_PER_DOC);
    const indexedChars = chunks.reduce((n, c) => n + c.length, 0);
    const docId = docIdFor(scope, 'doc', doc.fileId);
    const title = doc.name?.trim() || doc.fileId;
    const at = this.#now();
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM docs WHERE doc_id = ?').run(docId);
      this.#db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId);
      this.#db
        .prepare(
          'INSERT INTO docs (doc_id, chat_key, title, mime_type, chars, chunks, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          docId,
          scope,
          title,
          doc.mimeType ?? 'unknown',
          indexedChars,
          chunks.length,
          truncated ? 1 : 0,
          at,
        );
      const insertChunk = this.#db.prepare(
        'INSERT INTO doc_chunks (text, doc_id, chat_key, title, at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const chunk of chunks) insertChunk.run(chunk, docId, scope, title, at);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    try {
      writeFileSync(join(this.#directory, `${docId}.txt`), sliced);
    } catch (err) {
      log.warn('doc memory mirror write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      docId,
      title,
      mimeType: doc.mimeType ?? 'unknown',
      chunks: chunks.length,
      chars: indexedChars,
      truncated,
    };
  }

  /** Index a finished audio transcript so voice notes are queryable on the
   * same shelf as documents. The title is what the user said alongside, or a
   * bare marker; never an invented summary. */
  indexTranscript(
    scope: string,
    messageId: string,
    transcript: string,
    caption?: string,
  ): IndexedDocument | null {
    const allChunks = chunkText(transcript);
    if (!allChunks.length) return null;
    const truncated = allChunks.length > MAX_CHUNKS_PER_DOC;
    const chunks = allChunks.slice(0, MAX_CHUNKS_PER_DOC);
    const indexedChars = chunks.reduce((n, c) => n + c.length, 0);
    const docId = docIdFor(scope, 'audio', messageId);
    const title = caption?.trim() ? `audio: ${caption.trim()}` : `audio ${messageId}`;
    const at = this.#now();
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM docs WHERE doc_id = ?').run(docId);
      this.#db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId);
      this.#db
        .prepare(
          'INSERT INTO docs (doc_id, chat_key, title, mime_type, chars, chunks, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          docId,
          scope,
          title,
          'audio/transcript',
          indexedChars,
          chunks.length,
          truncated ? 1 : 0,
          at,
        );
      const insertChunk = this.#db.prepare(
        'INSERT INTO doc_chunks (text, doc_id, chat_key, title, at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const chunk of chunks) insertChunk.run(chunk, docId, scope, title, at);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return {
      docId,
      title,
      mimeType: 'audio/transcript',
      chunks: chunks.length,
      chars: indexedChars,
      truncated,
    };
  }

  /** Index the text an OCR pass read off a photo, under the same scope rules as
   * everything else. The title is the caption or a bare marker, never an invented
   * description: OCR only knows the text that was visible, and the shelf says so by
   * its mime type (`image/ocr`). Returns null when nothing legible came out. */
  indexOcr(scope: string, ref: string, text: string, caption?: string): IndexedDocument | null {
    const sliced = text.slice(0, MAX_TEXT_CHARS);
    const allChunks = chunkText(sliced);
    if (!allChunks.length) return null;
    const truncated = text.length > sliced.length || allChunks.length > MAX_CHUNKS_PER_DOC;
    const chunks = allChunks.slice(0, MAX_CHUNKS_PER_DOC);
    const indexedChars = chunks.reduce((n, c) => n + c.length, 0);
    const docId = docIdFor(scope, 'image', ref);
    const title = caption?.trim() ? `foto: ${caption.trim()}` : `foto ${ref.slice(-8)}`;
    const at = this.#now();
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM docs WHERE doc_id = ?').run(docId);
      this.#db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId);
      this.#db
        .prepare(
          'INSERT INTO docs (doc_id, chat_key, title, mime_type, chars, chunks, truncated, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(docId, scope, title, 'image/ocr', indexedChars, chunks.length, truncated ? 1 : 0, at);
      const insertChunk = this.#db.prepare(
        'INSERT INTO doc_chunks (text, doc_id, chat_key, title, at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const chunk of chunks) insertChunk.run(chunk, docId, scope, title, at);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return {
      docId,
      title,
      mimeType: 'image/ocr',
      chunks: chunks.length,
      chars: indexedChars,
      truncated,
    };
  }

  /** FTS5 search, always scoped. An empty or over-broad query returns nothing
   * rather than the whole shelf. */
  search(scope: string, query: string, limit = DEFAULT_SEARCH_LIMIT): DocSearchHit[] {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    // Quote each term so user punctuation never becomes FTS syntax. Terms are
    // ANDed: an OR over user words floods the shelf with near-misses.
    const terms = trimmed.split(/\s+/).filter((w) => w.replace(/[^\p{L}\p{N}_]/gu, '').length > 0);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    const rows = this.#db
      .prepare(
        `SELECT doc_id, title, at, snippet(doc_chunks, 0, '«', '»', '…', 24) AS snip,
                bm25(doc_chunks) AS score
         FROM doc_chunks
         WHERE doc_chunks MATCH ? AND chat_key = ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(match, scope, limit) as Array<{
      doc_id: string;
      title: string;
      at: number;
      snip: string;
      score: number;
    }>;
    return rows.map((r) => ({
      docId: r.doc_id,
      title: r.title,
      at: new Date(r.at).toISOString(),
      snippet: r.snip,
      rank: r.score,
    }));
  }

  /** What this scope has on the shelf, newest first. */
  list(scope: string, limit = 20): IndexedDocument[] {
    const rows = this.#db
      .prepare(
        'SELECT doc_id, title, mime_type, chunks, chars, truncated FROM docs WHERE chat_key = ? ORDER BY at DESC LIMIT ?',
      )
      .all(scope, limit) as Array<{
      doc_id: string;
      title: string;
      mime_type: string;
      chunks: number;
      chars: number;
      truncated: number;
    }>;
    return rows.map((r) => ({
      docId: r.doc_id,
      title: r.title,
      mimeType: r.mime_type,
      chunks: r.chunks,
      chars: r.chars,
      truncated: r.truncated === 1,
    }));
  }

  close(): void {
    this.#db.close();
  }
}
