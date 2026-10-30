import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PANEL_MAX_FILE_BYTES,
  PANEL_MAX_FILES,
  type PanelChatReply,
  panelFileDataUrl,
  panelFileName,
  runPanelChat,
  type TurnOutput,
} from '../src/daemon/panel-chat.js';
import { ThreadOutputs, threadContext } from '../src/daemon/thread-context.js';
import { startWebUi } from '../src/webui/server.js';

const PDF = Buffer.from('%PDF-1.4 hola');

function panelOut(accept: boolean, notes: string[] = []): TurnOutput & { got: string[] } {
  const got: string[] = [];
  return {
    got,
    answer: () => {},
    note: (t) => notes.push(t),
    file: (f) => {
      if (!accept) return false;
      got.push(f.name);
      return true;
    },
  };
}

describe('contexto por conversación: archivos de un turno del panel', () => {
  it('en un turno del panel el archivo va al panel y nada sale por Telegram', async () => {
    const outputs = new ThreadOutputs();
    const ctx = threadContext({ key: 'k', outputs, gate: null });
    const out = panelOut(true);
    outputs.bind('k', out);
    const telegram = vi.fn(async () => true);
    expect(await ctx.sendFile({ bytes: PDF, name: 'libro.pdf' }, telegram)).toBe(true);
    expect(telegram).not.toHaveBeenCalled();
    expect(out.got).toEqual(['libro.pdf']);
  });

  it('si el panel no lo acepta, avisa en el panel y va por Telegram como antes', async () => {
    const outputs = new ThreadOutputs();
    const ctx = threadContext({ key: 'k', outputs, gate: null });
    const notes: string[] = [];
    outputs.bind('k', panelOut(false, notes));
    const telegram = vi.fn(async () => 'enviado');
    expect(await ctx.sendFile({ bytes: PDF, name: 'peli.mp4' }, telegram)).toBe('enviado');
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(notes.join(' ')).toContain('«peli.mp4»');
    expect(notes.join(' ')).toContain('Telegram');
  });

  it('sin turno del panel es exactamente el envío por Telegram (resultado y errores)', async () => {
    const outputs = new ThreadOutputs();
    const ctx = threadContext({ key: 'k', outputs, gate: null });
    expect(await ctx.sendFile({ bytes: PDF, name: 'a.pdf' }, async () => false)).toBe(false);
    await expect(
      ctx.sendFile({ bytes: PDF, name: 'a.pdf' }, async () => {
        throw new Error('telegram caído');
      }),
    ).rejects.toThrow('telegram caído');
  });
});

describe('runPanelChat devuelve los archivos del turno', () => {
  const thread = () => ({ key: 'main', generation: 0, tail: Promise.resolve(), active: false });

  it('nombre sin rutas, tipo por extensión (lista corta) y tope de archivos y tamaño', async () => {
    const accepted: boolean[] = [];
    const res = await runPanelChat(thread(), 'pásame el libro', {
      remember: () => {},
      runTurn: async (_t, _s, out) => {
        accepted.push(out.file?.({ bytes: PDF, name: '../../etc/libro.pdf' }) ?? false);
        accepted.push(
          out.file?.({ bytes: Buffer.alloc(PANEL_MAX_FILE_BYTES + 1), name: 'grande.mp4' }) ??
            false,
        );
        for (let i = 0; i < PANEL_MAX_FILES; i++) {
          accepted.push(out.file?.({ bytes: PDF, name: `x${i}.html` }) ?? false);
        }
        out.answer('Listo');
      },
    });
    expect(accepted).toEqual([true, false, true, true, true, false]);
    expect(res.text).toBe('Listo');
    expect(res.files?.length).toBe(PANEL_MAX_FILES);
    expect(res.files?.[0]).toEqual({
      name: 'libro.pdf',
      url: `data:application/pdf;base64,${PDF.toString('base64')}`,
    });
    expect(res.files?.[1]?.url.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });

  it('sin archivos la respuesta no lleva files', async () => {
    const res = await runPanelChat(thread(), 'hola', {
      remember: () => {},
      runTurn: async (_t, _s, out) => out.answer('hola'),
    });
    expect(res).toEqual({ text: 'hola' });
  });

  it('nombres raros y tipos', () => {
    expect(panelFileName('C:\\Users\\nico\\a"<b>.epub')).toBe('ab.epub');
    expect(panelFileName('..')).toBe('archivo');
    expect(panelFileDataUrl({ bytes: PDF, name: 'nota.OGG' }).startsWith('data:audio/ogg;')).toBe(
      true,
    );
    expect(
      panelFileDataUrl({ bytes: PDF, name: 'x.svg' }).startsWith('data:application/octet-stream;'),
    ).toBe(true);
  });
});

describe('/api/chat devuelve los archivos del turno del panel', () => {
  const TOKEN = 'token-files-1';
  let reply: PanelChatReply = { text: 'ok' };
  let ui: Awaited<ReturnType<typeof startWebUi>>;
  beforeAll(async () => {
    ui = await startWebUi({
      token: TOKEN,
      status: () => ({ ok: true }),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({ ok: true }),
      chat: async () => reply,
    });
  });
  afterAll(async () => ui.close());
  async function chat(): Promise<Record<string, unknown>> {
    const res = await fetch(new URL('/api/chat', ui.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'pásame el pdf' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it('pasa los archivos válidos y descarta rutas, html y enlaces', async () => {
    const ok = { name: 'libro.pdf', url: 'data:application/pdf;base64,JVBERg==' };
    reply = {
      text: 'Aquí está',
      files: [
        ok,
        { name: '../x.pdf', url: 'data:application/pdf;base64,JVBERg==' },
        { name: 'x.html', url: 'data:text/html;base64,PGI+' },
        { name: 'x.pdf', url: 'https://example.com/x.pdf' },
      ],
    };
    expect(await chat()).toEqual({ text: 'Aquí está', files: [ok] });
  });

  it('sin archivos, la respuesta es la de siempre', async () => {
    reply = { text: 'hola' };
    expect(await chat()).toEqual({ text: 'hola' });
  });
});

describe('cableado en cli.ts: los archivos salen por el contexto del hilo', () => {
  const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  it('libros, descargas y media (documento, vídeo, voz, foto) pasan por ctx', () => {
    // libro + descarga (documento ×2), descarga + media (vídeo ×2), media (voz)
    expect(src.match(/ctx\.sendFile\(/g)?.length).toBe(5);
    expect(src).toMatch(/sendPhoto: \(bytes, opts\) =>\s*ctx\s*\.sendPhoto\(/);
  });
});
