import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BOOK_BYTES } from '../src/books/net.js';
import {
  SecretLibrary,
  type SecretMessage,
  type SecretTgClient,
  sniffsAsEpub,
} from '../src/books/secret.js';
import { createBookTool } from '../src/tools/book.js';

const EPUB = Buffer.from(
  `PK\x03\x04${' '.repeat(26)}mimetypeapplication/epub+zip${'x'.repeat(128)}`,
);
const NOT_EPUB = Buffer.from('%PDF-1.4 esto no es un epub aunque el bot diga que si......');

function msg(partial: Partial<SecretMessage> & { id: number }): SecretMessage {
  return {
    click: async () => null,
    ...partial,
  };
}

/** Cliente falso guionizado: responde segun el texto del ultimo envio. */
function fakeClient(script: {
  onSend?: (text: string, outbox: SecretMessage[]) => void;
  inbox?: SecretMessage[];
}) {
  const sent: string[] = [];
  const inbox: SecretMessage[] = [...(script.inbox ?? [])];
  const downloads: number[] = [];
  const client: SecretTgClient = {
    sendMessage: async (_e, opts) => {
      sent.push(opts.message);
      const m = msg({ id: 1000 + sent.length, message: opts.message });
      script.onSend?.(opts.message, inbox);
      return m;
    },
    getMessages: async (_e, opts) =>
      inbox.filter((m) => (opts.minId === undefined ? true : m.id > opts.minId)),
    downloadMedia: async (m) => {
      downloads.push(m.id);
      return EPUB;
    },
  };
  return { client, sent, inbox, downloads };
}

let dir: string;
let sessionPath: string;
let usagePath: string;
const env = { BOOKS_TG_API_ID: '12345', BOOKS_TG_API_HASH: 'a'.repeat(32) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secret-test-'));
  sessionPath = join(dir, 'userbot.session');
  usagePath = join(dir, 'usage.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mk = (deps: ConstructorParameters<typeof SecretLibrary>[0]) =>
  new SecretLibrary({
    env,
    sessionPath,
    usagePath,
    minGapMs: 0,
    pollMs: 1,
    replyTimeoutMs: 30,
    sleep: async () => undefined,
    ...deps,
  });

describe('sniffsAsEpub', () => {
  it('exige ZIP con mimetype EPUB; un PDF renombrado no cuela', () => {
    expect(sniffsAsEpub(EPUB)).toBe(true);
    expect(sniffsAsEpub(NOT_EPUB)).toBe(false);
    expect(sniffsAsEpub(Buffer.from('PK'))).toBe(false);
  });
});

describe('SecretLibrary.status', () => {
  it('sin credenciales dice que falta el setup, sin explotar', async () => {
    const lib = mk({ env: {} });
    const st = await lib.status();
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.reason).toContain('pa books setup');
  });

  it('con credenciales pero sin sesion dice que falta el login', async () => {
    const lib = mk({});
    const st = await lib.status();
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.reason).toContain('login');
  });

  it('con credenciales y sesion esta lista', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const lib = mk({});
    expect((await lib.status()).ok).toBe(true);
  });
});

describe('SecretLibrary.search', () => {
  it('parsea los pares titulo/codigo de la respuesta del bot', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient({
      onSend: (_t, inbox) => {
        inbox.push(
          msg({
            id: 2000,
            message: 'Resultados:\nEl nombre de la rosa /bNv7E\nLa sombra del viento /bxK2p',
          }),
        );
      },
    });
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    const hits = await lib.search('  /start  nombre de la rosa  ');
    expect(hits).toEqual([
      { title: 'El nombre de la rosa', code: 'bNv7E' },
      { title: 'La sombra del viento', code: 'bxK2p' },
    ]);
  });

  it('respuesta de texto sin codigos = el bot no lo tiene: [] sin error', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient({
      onSend: (_t, inbox) => {
        inbox.push(msg({ id: 2000, message: 'No se han encontrado resultados.' }));
      },
    });
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    await expect(lib.search('algo rarisimo')).resolves.toEqual([]);
  });

  it('sin respuesta: error honesto e invalida el descubrimiento', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient({});
    let invalidated = 0;
    const lib = mk({
      getClient: async () => client,
      discover: async () => 'BS_bot',
      invalidateDiscovery: () => {
        invalidated += 1;
      },
    });
    await expect(lib.search('x')).rejects.toThrow(/no ha respondido/);
    expect(invalidated).toBe(1);
  });

  it('busqueda vacia ni siquiera toca Telegram', async () => {
    const { client, sent } = fakeClient({});
    const lib = mk({ getClient: async () => client });
    await expect(lib.search('   ')).rejects.toThrow(/vac/i);
    expect(sent).toEqual([]);
  });
});

describe('SecretLibrary.download', () => {
  const scriptConFicha = {
    onSend: (t: string, inbox: SecretMessage[]) => {
      if (t === '/bNv7E') {
        inbox.push(
          msg({
            id: 2000,
            message: 'El nombre de la rosa - Umberto Eco\nPublicado: 1980 | 672 paginas',
            click: async () => {
              inbox.push(
                msg({
                  id: 2001,
                  document: { size: EPUB.length },
                }),
              );
              return null;
            },
          }),
        );
      }
    },
  };

  it('ficha -> click Epub -> documento -> bytes EPUB con el titulo de la ficha', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client, downloads } = fakeClient(scriptConFicha);
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    const got = await lib.download('bNv7E');
    expect(got.title).toBe('El nombre de la rosa');
    expect(got.bytes).toBe(EPUB);
    expect(downloads).toEqual([2001]);
  });

  it('documento que supera el tope: se rechaza ANTES de descargarlo', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client, downloads } = fakeClient({
      onSend: (t, inbox) => {
        if (t.startsWith('/b')) {
          inbox.push(
            msg({
              id: 2000,
              message: 'Ladrillo - Autor',
              click: async () => {
                inbox.push(msg({ id: 2001, document: { size: MAX_BOOK_BYTES + 1 } }));
                return null;
              },
            }),
          );
        }
      },
    });
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    await expect(lib.download('bNv7E')).rejects.toThrow(/tope/);
    expect(downloads).toEqual([]);
  });

  it('bytes que no son EPUB: error honesto, nunca exito', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient(scriptConFicha);
    const real = client.downloadMedia.bind(client);
    client.downloadMedia = async (m) => (m.id === 2001 ? NOT_EPUB : real(m));
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    await expect(lib.download('bNv7E')).rejects.toThrow(/no parece un EPUB/);
  });

  it('el bot no manda el archivo: no se da por descargado', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient({
      onSend: (t, inbox) => {
        if (t.startsWith('/b')) {
          inbox.push(msg({ id: 2000, message: 'Libro - Autor', click: async () => null }));
        }
      },
    });
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    await expect(lib.download('bNv7E')).rejects.toThrow(/no ha mandado el EPUB/);
  });

  it('codigo con pinta rara se rechaza sin tocar Telegram', async () => {
    const { client, sent } = fakeClient({});
    const lib = mk({ getClient: async () => client });
    await expect(lib.download('../../etc/passwd')).rejects.toThrow(/invalido/);
    expect(sent).toEqual([]);
  });
});

describe('anti-flood', () => {
  it('FloodWait de Telegram se traduce a "espera N segundos"', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient({});
    client.sendMessage = async () => {
      const err = new Error('RPC error FLOOD_WAIT_42') as Error & { seconds: number };
      err.seconds = 42;
      throw err;
    };
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    await expect(lib.search('x')).rejects.toThrow(/42 segundos/);
  });

  it('tope diario persistido: al llegar al limite no se manda nada mas', async () => {
    writeFileSync(sessionPath, 'SESSION');
    writeFileSync(
      usagePath,
      JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 2 }),
    );
    const { client, sent } = fakeClient({});
    const lib = mk({
      getClient: async () => client,
      discover: async () => 'BS_bot',
      maxInteractionsPerDay: 2,
    });
    await expect(lib.search('x')).rejects.toThrow(/tope diario/);
    expect(sent).toEqual([]);
  });

  it('el contador del dia se guarda en disco (sobrevive a reinicios)', async () => {
    writeFileSync(sessionPath, 'SESSION');
    const { client } = fakeClient({
      onSend: (_t, inbox) => {
        inbox.push(msg({ id: 2000, message: 'Sin resultados.' }));
      },
    });
    const lib = mk({ getClient: async () => client, discover: async () => 'BS_bot' });
    await lib.search('x');
    const saved = JSON.parse((await import('node:fs')).readFileSync(usagePath, 'utf8')) as {
      count: number;
    };
    expect(saved.count).toBeGreaterThanOrEqual(1);
  });
});

describe('book tool + Biblioteca Secreta', () => {
  const run = async (tool: AgentTool, args: Record<string, unknown>) =>
    (await tool.execute('1', args as never)).content
      .map((c) => ('text' in c ? c.text : ''))
      .join('\n');

  const mkTool = (secret: unknown) => {
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
      // Fuentes publicas vacias siempre: el fallback es lo que se prueba.
      getJson: async (u: string) =>
        u.includes('gutendex') ? { results: [] } : { response: { docs: [] } },
      fetcher: async () => new Response(new Uint8Array(EPUB)),
      secret,
    } as never);
    return { tool: tool as unknown as AgentTool, docs };
  };

  it('sin resultados publicos, ofrece los de Biblioteca Secreta con su id', async () => {
    const { tool } = mkTool({
      status: async () => ({ ok: true }),
      search: async () => [{ title: 'El nombre de la rosa', code: 'bNv7E' }],
      download: async () => ({ title: 'x', bytes: EPUB }),
    });
    const text = await run(tool, { action: 'search', query: 'nombre de la rosa' });
    expect(text).toContain('Biblioteca Secreta');
    expect(text).toContain('id=secret:bNv7E');
  });

  it('get secret:CODE descarga por el userbot y envia el EPUB al chat', async () => {
    const { tool, docs } = mkTool({
      status: async () => ({ ok: true }),
      search: async () => [],
      download: async (code: string) => {
        expect(code).toBe('bNv7E');
        return { title: 'El nombre de la rosa', bytes: EPUB };
      },
    });
    const text = await run(tool, { action: 'get', id: 'secret:bNv7E' });
    expect(text).toContain('Enviado a este chat');
    expect(docs[0]?.name).toBe('El nombre de la rosa.epub');
    expect(docs[0]?.bytes).toBe(EPUB);
  });

  it('fallo de la descarga: error honesto y NADA se envia al chat', async () => {
    const { tool, docs } = mkTool({
      status: async () => ({ ok: true }),
      search: async () => [],
      download: async () => {
        throw new Error('lo que ha mandado el bot no parece un EPUB de verdad');
      },
    });
    await expect(run(tool, { action: 'get', id: 'secret:bNv7E' })).rejects.toThrow(/EPUB/);
    expect(docs).toEqual([]);
  });

  it('sin sesion del userbot, la busqueda lo dice en vez de fingir', async () => {
    const { tool } = mkTool({
      status: async () => ({ ok: false, reason: 'falta el login de Telegram (pa books setup)' }),
      search: async () => [],
      download: async () => ({ title: 'x', bytes: EPUB }),
    });
    const text = await run(tool, { action: 'search', query: 'harry potter' });
    expect(text).toContain('No he encontrado');
    expect(text).toContain('Biblioteca Secreta');
    expect(text).toContain('pa books setup');
  });

  it('si tampoco esta en Biblioteca Secreta, se dice', async () => {
    const { tool } = mkTool({
      status: async () => ({ ok: true }),
      search: async () => [],
      download: async () => ({ title: 'x', bytes: EPUB }),
    });
    const text = await run(tool, { action: 'search', query: 'harry potter' });
    expect(text).toContain('Biblioteca Secreta tampoco');
  });
});
