import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
 * Scope is per chat key, like the note memory: a document from one chat is
 * never surfaced in another. Photos are not here on purpose: a photo goes
 * straight to the model's eyes in its own turn, and an index of unreviewed
 * vision descriptions would quote guesses as if they were the document.
 */

/** One forwarded document, as the channel describes it. */
export interface IncomingDocument {
  /** Telegram file_id or equivalent: only used to build a stable id. */
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
  chars: number;
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
}

/** A document bigger than this extracts more noise than signal in one pass. */
const MAX_TEXT_CHARS = 1_000_000;
/** Chunk size tuned so a chunk answers a question on its own. */
const CHUNK_CHARS = 1500;
const MAX_CHUNKS_PER_DOC = 400;
/** Extraction of one document never burns more than this. */
const EXTRACT_TIMEOUT_MS = 60_000;
const DEFAULT_SEARCH_LIMIT = 8;

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
    if ((current + '\n\n' + para).trim().length > chunkChars && current.trim()) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.slice(0, MAX_CHUNKS_PER_DOC);
}

/** pdfjs-dist is heavy (~5 MB wasm-less but still), so it loads on first PDF,
 * not at daemon start: a daemon whose user never forwards a PDF never pays it.
 * Text that pdfjs cannot get (scanned image PDFs) comes back empty and the
 * caller reports that honestly instead of pretending the index saw something.
 */
async function extractPdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await withTimeout(
    loadingTask.promise,
    EXTRACT_TIMEOUT_MS,
    'pdf extraction timed out',
  );
  try {
    const parts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
      page.cleanup();
    }
    return parts.join('\n\n');
  } finally {
    await loadingTask.destroy();
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

export async function extractText(bytes: Buffer, mimeType?: string): Promise<string> {
  if (!mimeType) return '';
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf') return extractPdfText(bytes);
  if (canExtract(mimeType)) return bytes.toString('utf8');
  return '';
}

/** The sqlite FTS5 store. One instance per daemon; the per-chat scoping is a
 * column, not a file, because the per-chat note memory already proved that a
 * scope argument the caller supplies beats a file per chat you forget to open.
 */
export class DocMemory {
  readonly #db: DatabaseSync;
  readonly #directory: string;
  readonly #now: () => number;

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
    this.#directory = options.directory;
    this.#now = options.now ?? Date.now;
  }

  /** Index one downloaded document. Returns null when there was no readable
   * text (scanned PDF, empty file) so the caller can say so instead of
   * claiming a memory it does not have. */
  async index(
    chatKey: string,
    doc: IncomingDocument,
    bytes: Buffer,
  ): Promise<IndexedDocument | null> {
    const text = (await extractText(bytes, doc.mimeType)).slice(0, MAX_TEXT_CHARS);
    const chunks = chunkText(text);
    if (!chunks.length) return null;
    const docId = createHash('sha256').update(doc.fileId).digest('hex').slice(0, 16);
    const title = doc.name?.trim() || doc.fileId;
    const at = this.#now();
    this.#db.prepare('DELETE FROM docs WHERE doc_id = ?').run(docId);
    this.#db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId);
    this.#db
      .prepare(
        'INSERT INTO docs (doc_id, chat_key, title, mime_type, chars, chunks, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(docId, chatKey, title, doc.mimeType ?? 'unknown', text.length, chunks.length, at);
    const insertChunk = this.#db.prepare(
      'INSERT INTO doc_chunks (text, doc_id, chat_key, title, at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const chunk of chunks) insertChunk.run(chunk, docId, chatKey, title, at);
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(this.#directory, `${docId}.txt`), text);
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
      chars: text.length,
    };
  }

  /** Index a finished audio transcript so voice notes are queryable on the
   * same shelf as documents. The title is what the user said alongside, or a
   * bare marker; never an invented summary. */
  indexTranscript(
    chatKey: string,
    messageId: string,
    transcript: string,
    caption?: string,
  ): IndexedDocument | null {
    const chunks = chunkText(transcript);
    if (!chunks.length) return null;
    const docId = createHash('sha256').update(`audio:${messageId}`).digest('hex').slice(0, 16);
    const title = caption?.trim() ? `audio: ${caption.trim()}` : `audio ${messageId}`;
    const at = this.#now();
    this.#db.prepare('DELETE FROM docs WHERE doc_id = ?').run(docId);
    this.#db.prepare('DELETE FROM doc_chunks WHERE doc_id = ?').run(docId);
    this.#db
      .prepare(
        'INSERT INTO docs (doc_id, chat_key, title, mime_type, chars, chunks, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(docId, chatKey, title, 'audio/transcript', transcript.length, chunks.length, at);
    const insertChunk = this.#db.prepare(
      'INSERT INTO doc_chunks (text, doc_id, chat_key, title, at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const chunk of chunks) insertChunk.run(chunk, docId, chatKey, title, at);
    return {
      docId,
      title,
      mimeType: 'audio/transcript',
      chunks: chunks.length,
      chars: transcript.length,
    };
  }

  /** FTS5 search, always scoped to one chat. An empty or over-broad query
   * returns nothing rather than the whole shelf. */
  search(chatKey: string, query: string, limit = DEFAULT_SEARCH_LIMIT): DocSearchHit[] {
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
      .all(match, chatKey, limit) as Array<{
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

  /** What this chat has on the shelf, newest first. */
  list(chatKey: string, limit = 20): IndexedDocument[] {
    const rows = this.#db
      .prepare(
        'SELECT doc_id, title, mime_type, chunks, chars FROM docs WHERE chat_key = ? ORDER BY at DESC LIMIT ?',
      )
      .all(chatKey, limit) as Array<{
      doc_id: string;
      title: string;
      mime_type: string;
      chunks: number;
      chars: number;
    }>;
    return rows.map((r) => ({
      docId: r.doc_id,
      title: r.title,
      mimeType: r.mime_type,
      chunks: r.chunks,
      chars: r.chars,
    }));
  }

  close(): void {
    this.#db.close();
  }
}
