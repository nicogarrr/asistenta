import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canExtract, chunkText, DocMemory, extractText } from '../src/memory/docs.js';

/** A minimal one-page PDF with one text object, built byte-exact in test so
 * the suite never downloads a fixture. pdfjs reads uncompressed content
 * streams fine; the xref offsets are computed, not hand-counted. */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, (c) => '\\' + c)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

describe('chunkText', () => {
  it('splits on paragraph boundaries and keeps chunks under the cap', () => {
    const paras = Array.from({ length: 12 }, (_, i) => `parrafo ${i} ` + 'x'.repeat(300)).join(
      '\n\n',
    );
    const chunks = chunkText(paras, 1500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1500);
    expect(chunks.join(' ')).toContain('parrafo 0');
    expect(chunks.join(' ')).toContain('parrafo 11');
  });

  it('hard-wraps a single over-long paragraph', () => {
    const chunks = chunkText('y'.repeat(4000), 1500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!).toHaveLength(1500);
  });

  it('returns nothing for blank text', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
  });

  it("returns every chunk - capping is the store's job, so coverage is measurable", () => {
    expect(chunkText('z'.repeat(2_000_000), 1500).length).toBeGreaterThan(400);
  });
});

describe('canExtract / extractText', () => {
  it('refuses what it cannot read', () => {
    expect(canExtract('image/png')).toBe(false);
    expect(canExtract(undefined)).toBe(false);
    expect(canExtract('application/pdf')).toBe(true);
    expect(canExtract('text/plain')).toBe(true);
    expect(canExtract('text/csv')).toBe(true);
  });

  it('reads utf8 text types directly', async () => {
    await expect(extractText(Buffer.from('hola qué tal', 'utf8'), 'text/plain')).resolves.toBe(
      'hola qué tal',
    );
  });

  it('extracts text from a real PDF', async () => {
    const text = await extractText(
      minimalPdf('clausula de permanencia doce meses'),
      'application/pdf',
    );
    expect(text).toMatch(/permanencia/);
    expect(text).toMatch(/doce meses/);
  });

  it('times out a PDF whose loading never resolves, and destroys the task', async () => {
    let destroyed = false;
    const hangingLoader = async () => ({
      getDocument: () => ({
        promise: new Promise<never>(() => {}),
        destroy: async () => {
          destroyed = true;
        },
      }),
    });
    const start = Date.now();
    await expect(
      extractText(Buffer.from('%PDF-1.4'), 'application/pdf', hangingLoader, 500),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(destroyed).toBe(true);
  });
});

describe('DocMemory', () => {
  let dir: string;
  let mem: DocMemory;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'docmem-'));
    mem = new DocMemory({
      dbPath: join(dir, 'docs.sqlite'),
      directory: join(dir, 'mirror'),
      now: () => 1_800_000_000_000,
    });
  });
  afterAll(() => {
    mem.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes a document and finds it by content', async () => {
    const doc = await mem.index(
      'chat-a',
      { fileId: 'f1', name: 'contrato.pdf', mimeType: 'application/pdf' },
      minimalPdf('penalizacion por desistimiento anticipado'),
    );
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe('contrato.pdf');
    expect(doc!.truncated).toBe(false);
    const hits = mem.search('chat-a', 'desistimiento');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.docId).toBe(doc!.docId);
    expect(hits[0]!.snippet).toMatch(/«desistimiento»/i);
  });

  it('keeps scopes isolated even for the same forwarded file', async () => {
    const a = await mem.index(
      'chat-a',
      { fileId: 'shared', name: 'doc-a.txt', mimeType: 'text/plain' },
      Buffer.from('contenido almendra'),
    );
    const b = await mem.index(
      'chat-b',
      { fileId: 'shared', name: 'doc-b.txt', mimeType: 'text/plain' },
      Buffer.from('contenido almendra'),
    );
    expect(a!.docId).not.toBe(b!.docId);
    // Reindexing in B must not evict A's copy.
    await mem.index(
      'chat-b',
      { fileId: 'shared', name: 'doc-b.txt', mimeType: 'text/plain' },
      Buffer.from('contenido nuevo nuez'),
    );
    expect(mem.search('chat-a', 'almendra')).toHaveLength(1);
    expect(mem.search('chat-b', 'almendra')).toHaveLength(0);
    expect(mem.search('chat-b', 'nuez')).toHaveLength(1);
  });

  it('scopes audio ids too: same message id in two chats is two audios', async () => {
    const a = mem.indexTranscript('chat-a', '42', 'audio cacahuete de a');
    const b = mem.indexTranscript('chat-b', '42', 'audio pistacho de b');
    expect(a!.docId).not.toBe(b!.docId);
    expect(mem.search('chat-a', 'cacahuete')).toHaveLength(1);
    expect(mem.search('chat-b', 'pistacho')).toHaveLength(1);
  });

  it('reports truncation honestly: indexed chars, not extracted chars', async () => {
    const big = Buffer.from('z'.repeat(610_009));
    const doc = await mem.index(
      'chat-a',
      { fileId: 'big', name: 'largo.txt', mimeType: 'text/plain' },
      big,
    );
    expect(doc).not.toBeNull();
    expect(doc!.truncated).toBe(true);
    expect(doc!.chars).toBeLessThanOrEqual(400 * 1500);
    expect(doc!.chars).toBeLessThan(610_009);
    // And the shelf says so.
    expect(mem.list('chat-a').find((d) => d.title === 'largo.txt')!.truncated).toBe(true);
  });

  it('returns null when there is no readable text', async () => {
    const doc = await mem.index(
      'chat-a',
      { fileId: 'f3', name: 'vacio.txt', mimeType: 'text/plain' },
      Buffer.from('   '),
    );
    expect(doc).toBeNull();
  });

  it('reindexing the same file replaces, never duplicates', async () => {
    await mem.index(
      'chat-a',
      { fileId: 'f4', name: 'notas.txt', mimeType: 'text/plain' },
      Buffer.from('primera version'),
    );
    await mem.index(
      'chat-a',
      { fileId: 'f4', name: 'notas.txt', mimeType: 'text/plain' },
      Buffer.from('segunda version'),
    );
    expect(mem.search('chat-a', 'primera')).toHaveLength(0);
    expect(mem.search('chat-a', 'segunda')).toHaveLength(1);
    expect(mem.list('chat-a').filter((d) => d.title === 'notas.txt')).toHaveLength(1);
  });

  it('ANDs query terms and survives FTS punctuation', async () => {
    await mem.index(
      'chat-a',
      { fileId: 'f5', name: 'mix.txt', mimeType: 'text/plain' },
      Buffer.from('rojo y verde. solo rojo.'),
    );
    expect(mem.search('chat-a', 'rojo verde')).toHaveLength(1);
    expect(mem.search('chat-a', 'rojo azul')).toHaveLength(0);
    expect(() => mem.search('chat-a', 'rojo (verde) OR *')).not.toThrow();
    expect(mem.search('chat-a', '   ')).toHaveLength(0);
    expect(mem.search('chat-a', 'a')).toHaveLength(0);
  });

  it('indexes audio transcripts on the same shelf', async () => {
    const doc = mem.indexTranscript(
      'chat-a',
      'msg-9',
      'recuerda que la ferreteria cierra los festivos',
      'ferreteria',
    );
    expect(doc).not.toBeNull();
    expect(doc!.title).toMatch(/ferreteria/);
    const hits = mem.search('chat-a', 'festivos');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.docId).toBe(doc!.docId);
  });

  it('compound id boundaries: a/docx and adoc/x are different docs', async () => {
    await mem.index('a', { fileId: 'docx', mimeType: 'text/plain' }, Buffer.from('aguacate'));
    await mem.index('adoc', { fileId: 'x', mimeType: 'text/plain' }, Buffer.from('tomate'));
    expect(mem.search('a', 'aguacate')).toHaveLength(1);
  });

  it('an ordinary multi-paragraph document is NOT truncated', async () => {
    const doc = await mem.index(
      'chat-a',
      { fileId: 'multi', mimeType: 'text/plain' },
      Buffer.from('primero\n\nsegundo'),
    );
    expect(doc!.truncated).toBe(false);
  });

  it('a paragraph separator at the chunk boundary is not missing coverage', async () => {
    const doc = await mem.index(
      'chat-a',
      { fileId: 'boundary', mimeType: 'text/plain' },
      Buffer.from('x'.repeat(1490) + '\n\n' + 'segundo parrafo de veinte letras'),
    );
    expect(doc!.truncated).toBe(false);
    expect(mem.search('chat-a', 'segundo parrafo')).toHaveLength(1);
  });

  it('a hanging pdf loader obeys the total deadline', async () => {
    const outcome = await Promise.race([
      extractText(
        Buffer.from('pdf'),
        'application/pdf',
        () => new Promise<never>(() => {}),
        5,
      ).then(
        () => 'ok',
        () => 'timeout',
      ),
      new Promise((r) => setTimeout(() => r('hung'), 2_000)),
    ]);
    expect(outcome).toBe('timeout');
  });

  it('a hanging destroy cannot defeat the deadline', async () => {
    const loader = async () => ({
      getDocument: () => ({
        promise: new Promise<never>(() => {}),
        destroy: () => new Promise<void>(() => {}),
      }),
    });
    const outcome = await Promise.race([
      extractText(Buffer.from('pdf'), 'application/pdf', loader, 5).then(
        () => 'ok',
        () => 'timeout',
      ),
      new Promise((r) => setTimeout(() => r('hung'), 2_000)),
    ]);
    expect(outcome).toBe('timeout');
  });

  it('mirrors extracted text to disk', async () => {
    const doc = await mem.index(
      'chat-a',
      { fileId: 'f6', name: 'mirror.txt', mimeType: 'text/plain' },
      Buffer.from('contenido espejo'),
    );
    expect(doc).not.toBeNull();
    expect(readFileSync(join(dir, 'mirror', `${doc!.docId}.txt`), 'utf8')).toBe('contenido espejo');
  });
});

describe('DocMemory schema migration', () => {
  it('opens a pre-truncated-column database and upgrades it', async () => {
    const d = mkdtempSync(join(tmpdir(), 'docmig-'));
    const dbPath = join(d, 'old.sqlite');
    // An R1-shaped database: docs without the truncated column.
    const { DatabaseSync } = await import('node:sqlite');
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`CREATE TABLE docs (
      doc_id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, title TEXT NOT NULL,
      mime_type TEXT NOT NULL, chars INTEGER NOT NULL, chunks INTEGER NOT NULL, at INTEGER NOT NULL
    )`);
    oldDb.close();
    const m = new DocMemory({ dbPath, directory: join(d, 'mirror') });
    const doc = await m.index(
      'chat-a',
      { fileId: 'post', name: 'post.txt', mimeType: 'text/plain' },
      Buffer.from('despues de la migracion'),
    );
    expect(doc).not.toBeNull();
    expect(m.search('chat-a', 'migracion')).toHaveLength(1);
    expect(m.list('chat-a')[0]!.truncated).toBe(false);
    m.close();
    rmSync(d, { recursive: true, force: true });
  });
});
