import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  converterCandidates,
  findConverter,
  pdfToEpub,
  type Runner,
} from '../src/books/convert.js';
import { isKindleAddress, safeFilename, sendToKindle } from '../src/books/kindle.js';
import { allowedBookHost, downloadBook, sniff } from '../src/books/net.js';
import {
  pickFile,
  resolveArchive,
  searchArchive,
  searchGutenberg,
  tidyAuthor,
} from '../src/books/sources.js';
import { createBookTool } from '../src/tools/book.js';

const EPUB = Buffer.from('PK\x03\x04 fake epub');
const PDF = Buffer.from('%PDF-1.4 fake pdf');

const gutendex = {
  results: [
    {
      id: 2000,
      title: 'Don Quijote',
      authors: [{ name: 'Cervantes Saavedra, Miguel de' }],
      languages: ['es'],
      copyright: false,
      download_count: 10,
      formats: { 'application/epub+zip': 'https://www.gutenberg.org/ebooks/2000.epub3.images' },
    },
    {
      id: 1,
      title: 'Con derechos',
      authors: [],
      languages: ['en'],
      copyright: true,
      formats: { 'application/epub+zip': 'https://www.gutenberg.org/x.epub' },
    },
    {
      id: 2,
      title: 'Desconocido',
      authors: [],
      languages: ['en'],
      copyright: null,
      formats: { 'application/epub+zip': 'https://www.gutenberg.org/y.epub' },
    },
    {
      id: 3,
      title: 'Sin archivo',
      authors: [],
      languages: ['en'],
      copyright: false,
      formats: { 'text/html': 'https://www.gutenberg.org/z.html' },
    },
  ],
};

describe('sources', () => {
  it('Gutenberg: only explicit public domain with an EPUB/PDF', async () => {
    let asked = '';
    const hits = await searchGutenberg(
      'quijote',
      async (u) => {
        asked = u;
        return gutendex;
      },
      {
        language: 'es',
      },
    );
    expect(asked).toContain('search=quijote');
    expect(asked).toContain('languages=es');
    expect(hits.map((h) => h.id)).toEqual(['2000']);
    expect(hits[0]?.authors).toEqual(['Miguel de Cervantes Saavedra']);
    expect(hits[0]?.files[0]?.kind).toBe('epub');
  });

  it('Archive: the query is limited to NOT_IN_COPYRIGHT texts and operators are stripped', async () => {
    let asked = '';
    const hits = await searchArchive('"quijote" OR creator:(x)', async (u) => {
      asked = u;
      return {
        response: { docs: [{ identifier: 'abc', title: 'T', creator: 'C', language: 'spa' }, {}] },
      };
    });
    expect(decodeURIComponent(asked)).toContain('possible-copyright-status:NOT_IN_COPYRIGHT');
    expect(decodeURIComponent(asked)).not.toContain('creator:(x)');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: 'archive', id: 'abc', authors: ['C'] });
  });

  const meta = (status: string) => ({
    metadata: { 'possible-copyright-status': status, title: 'Libro' },
    files: [
      { name: 'a b.pdf', format: 'Image Container PDF', size: '10' },
      { name: 'a.epub', format: 'EPUB', size: '5' },
      { name: 'a_text.pdf', format: 'Text PDF', size: '8' },
      { name: 'a.jpg', format: 'JPEG' },
    ],
  });

  it('Archive resolve: refuses items not marked public domain', async () => {
    await expect(resolveArchive('abc', async () => meta('UNKNOWN'))).rejects.toThrow(
      /dominio público/,
    );
    await expect(resolveArchive('../x', async () => meta('NOT_IN_COPYRIGHT'))).rejects.toThrow();
  });

  it('prefers EPUB, then text PDF, then scanned PDF', async () => {
    const files = await resolveArchive('abc', async () => meta('NOT_IN_COPYRIGHT'));
    expect(files).toHaveLength(3);
    expect(pickFile(files)?.kind).toBe('epub');
    expect(pickFile(files.filter((f) => f.kind === 'pdf'))?.scanned).toBeUndefined();
    expect(pickFile(files.filter((f) => f.scanned))?.scanned).toBe(true);
    expect(files.find((f) => f.scanned)?.url).toContain('a%20b.pdf');
  });

  it('tidyAuthor', () => {
    expect(tidyAuthor('Verne, Jules')).toBe('Jules Verne');
    expect(tidyAuthor('Anónimo')).toBe('Anónimo');
  });
});

describe('net', () => {
  it('only https and the book hosts', () => {
    expect(allowedBookHost('https://www.gutenberg.org/a')).toBe(true);
    expect(allowedBookHost('https://ia800.us.archive.org/x')).toBe(true);
    expect(allowedBookHost('http://www.gutenberg.org/a')).toBe(false);
    expect(allowedBookHost('https://evilgutenberg.org/a')).toBe(false);
    expect(allowedBookHost('https://gutenberg.org.evil.com/a')).toBe(false);
    expect(allowedBookHost('https://169.254.169.254/')).toBe(false);
  });

  const res = (body: Buffer, init: ResponseInit = {}) => new Response(new Uint8Array(body), init);

  it('follows redirects by hand and rechecks each hop', async () => {
    const calls: string[] = [];
    const ok = await downloadBook('https://www.gutenberg.org/e', async (u) => {
      calls.push(u);
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://ia1.us.archive.org/f.epub' },
          })
        : res(EPUB);
    });
    expect(ok.kind).toBe('epub');
    await expect(
      downloadBook(
        'https://www.gutenberg.org/e',
        async () =>
          new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      ),
    ).rejects.toThrow(/fuera de las fuentes/);
  });

  it('rejects wrong content and oversize files', async () => {
    await expect(
      downloadBook('https://www.gutenberg.org/e', async () => res(Buffer.from('<html>'))),
    ).rejects.toThrow(/no es un EPUB/);
    await expect(
      downloadBook('https://www.gutenberg.org/e', async () => res(PDF), 5),
    ).rejects.toThrow(/50 MB/);
    expect(sniff(PDF)).toBe('pdf');
    expect(sniff(EPUB)).toBe('epub');
  });
});

describe('convert', () => {
  it('finds a converter or reports none', async () => {
    const none: Runner = async () => ({ code: 1, stderr: '' });
    expect(await findConverter(none, {})).toBeNull();
    const okRun: Runner = async (cmd) => ({ code: cmd === 'ebook-convert' ? 0 : 1, stderr: '' });
    expect(await findConverter(okRun, {})).toBe('ebook-convert');
    // Built with join rather than a literal: the expectation has to hold on Windows
    // (backslashes) and on a server (forward slashes), and `replace('/', sep)` only ever
    // fixed the first of the two separators.
    expect(converterCandidates({ ProgramFiles: 'C:\\P' })).toContain(
      join('C:\\P', 'Calibre2', 'ebook-convert.exe'),
    );
  });

  it('keeps the PDF when there is no converter', async () => {
    const r = await pdfToEpub(PDF, 'T', async () => ({ code: 1, stderr: '' }), null);
    expect(r).toMatchObject({ ok: false, reason: 'no-converter' });
  });

  it('runs ebook-convert with input, output and title, and returns the EPUB', async () => {
    let args: string[] = [];
    const run: Runner = async (_c, a) => {
      args = a;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(a[1] as string, EPUB);
      return { code: 0, stderr: '' };
    };
    const r = await pdfToEpub(PDF, 'Mi libro', run, 'ebook-convert');
    expect(r.ok).toBe(true);
    expect(args[0]).toMatch(/libro\.pdf$/);
    expect(args[1]).toMatch(/libro\.epub$/);
    expect(args).toContain('Mi libro');
  });

  it('reports a failed conversion', async () => {
    const r = await pdfToEpub(PDF, 'T', async () => ({ code: 2, stderr: 'boom' }), 'ebook-convert');
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('kindle delivery', () => {
  const account = {
    address: 'asistenta@example.com',
    password: 'p',
    imapHost: '',
    imapPort: 1,
    smtpHost: '',
    smtpPort: 1,
  };
  const book = { title: 'Don Quijote', bytes: EPUB, kind: 'epub' as const };

  it('validates addresses and file names', () => {
    expect(isKindleAddress('nico_1@kindle.com')).toBe(true);
    expect(isKindleAddress('nico@gmail.com')).toBe(false);
    expect(isKindleAddress('x@kindle.com.evil.com')).toBe(false);
    expect(safeFilename('Ñandú: el "libro"/1', 'epub')).toBe('Nandu el libro 1.epub');
  });

  const deps = (over: Partial<Parameters<typeof sendToKindle>[0]> = {}) => {
    const sent: unknown[] = [];
    return {
      sent,
      d: {
        getAddress: async () => 'nico@kindle.com',
        loadAccount: async () => account,
        send: async (_a: unknown, req: unknown) => {
          sent.push(req);
          return { ok: true as const };
        },
        requireApproval: async () => true,
        ...over,
      },
    };
  };

  it('sends only to the saved address, with the attachment, after approval', async () => {
    const { d, sent } = deps();
    expect(await sendToKindle(d as never, book)).toEqual({ status: 'sent', to: 'nico@kindle.com' });
    expect(sent[0]).toMatchObject({
      to: ['nico@kindle.com'],
      attachments: [{ filename: 'Don Quijote.epub' }],
    });
  });

  it('asks with the book and the address, and sends nothing when declined', async () => {
    let summary = '';
    const { d, sent } = deps({
      requireApproval: async (_a: string, s: string) => {
        summary = s;
        return false;
      },
    });
    expect(await sendToKindle(d as never, book)).toEqual({ status: 'declined' });
    expect(summary).toContain('Don Quijote');
    expect(summary).toContain('nico@kindle.com');
    expect(sent).toHaveLength(0);
  });

  it('reports the honest blockers', async () => {
    expect(await sendToKindle(deps({ getAddress: async () => null }).d as never, book)).toEqual({
      status: 'no-address',
    });
    expect(await sendToKindle(deps({ loadAccount: async () => null }).d as never, book)).toEqual({
      status: 'no-mail-account',
    });
    const bad = deps({ send: async () => ({ ok: false as const, error: 'auth' }) });
    expect(await sendToKindle(bad.d as never, book)).toEqual({ status: 'error', message: 'auth' });
  });
});

describe('book tool', () => {
  const run = async (tool: AgentTool, args: Record<string, unknown>) =>
    (await tool.execute('1', args as never)).content
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n');

  const mk = (over: Record<string, unknown> = {}) => {
    const docs: Array<{ name: string; bytes: Buffer }> = [];
    const tool = createBookTool({
      sendDocument: async (bytes: Buffer, name: string) => {
        docs.push({ name, bytes });
        return true;
      },
      kindle: {
        getAddress: async () => null,
        loadAccount: async () => null,
        send: async () => ({ ok: true }),
        requireApproval: async () => true,
      },
      saveKindleAddress: async () => undefined,
      getJson: async (u: string) => {
        if (u.includes('gutendex'))
          return u.includes('/books/2000') ? gutendex.results[0] : gutendex;
        if (u.includes('advancedsearch')) return { response: { docs: [] } };
        throw new Error(`unexpected ${u}`);
      },
      fetcher: async () => new Response(new Uint8Array(EPUB)),
      ...over,
    } as never);
    return { tool: tool as unknown as AgentTool, docs };
  };

  it('search lists options with ids; an unavailable book says so honestly', async () => {
    const { tool } = mk();
    expect(await run(tool, { action: 'search', query: 'quijote' })).toContain('id=gutenberg:2000');
    const empty = mk({
      getJson: async (u: string) =>
        u.includes('gutendex') ? { results: [] } : { response: { docs: [] } },
    });
    expect(await run(empty.tool, { action: 'search', query: 'harry potter' })).toContain(
      'derechos de autor',
    );
  });

  it('get downloads the EPUB and sends it to the chat', async () => {
    const { tool, docs } = mk();
    const text = await run(tool, { action: 'get', id: 'gutenberg:2000' });
    expect(text).toContain('Enviado a este chat');
    expect(docs[0]?.name).toBe('Don Quijote.epub');
  });

  it('get with a PDF converts it, or says it kept the PDF', async () => {
    const pdfSource = {
      getJson: async () => ({
        ...gutendex.results[0],
        formats: { 'application/pdf': 'https://www.gutenberg.org/p.pdf' },
      }),
      fetcher: async () => new Response(new Uint8Array(PDF)),
    };
    const conv = mk({ ...pdfSource, convert: async () => ({ ok: true, epub: EPUB }) });
    expect(await run(conv.tool, { action: 'get', id: 'gutenberg:2000' })).toContain(
      'convertido de PDF a EPUB',
    );
    expect(conv.docs[0]?.name).toBe('Don Quijote.epub');
    const none = mk({
      ...pdfSource,
      convert: async () => ({
        ok: false,
        reason: 'no-converter',
        message: 'no hay conversor instalado',
      }),
    });
    const t = await run(none.tool, { action: 'get', id: 'gutenberg:2000' });
    expect(t).toContain('no hay conversor');
    expect(none.docs[0]?.name).toBe('Don Quijote.pdf');
  });

  it('kindle without address or mailbox is an honest blocker and the book still reaches the chat', async () => {
    const { tool, docs } = mk();
    const t = await run(tool, { action: 'get', id: 'gutenberg:2000', deliver: 'both' });
    expect(t).toContain('Falta tu dirección de Kindle');
    expect(docs).toHaveLength(1);
  });

  it('rejects ids that are not from a search (no URLs from the model)', async () => {
    const { tool } = mk();
    await expect(run(tool, { action: 'get', id: 'https://evil.example/x.epub' })).rejects.toThrow(
      /id no válido/,
    );
    await expect(run(tool, { action: 'set_kindle', address: 'a@gmail.com' })).rejects.toThrow(
      /Kindle/,
    );
  });
});
