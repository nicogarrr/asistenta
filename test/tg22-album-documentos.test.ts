/**
 * Varios documentos enviados de una vez (varios PDF seleccionados juntos) llegan de
 * Telegram como un mensaje por fichero con el mismo media_group_id. Antes cada uno era
 * un turno: «Documento reenviado… indexado» una vez por fichero y «compáralos» se
 * contestaba con solo el primero. Ahora es un solo turno con todos. Bot API falsa,
 * relojes falsos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
    };
    on(event: string, fn: (ctx: unknown) => unknown): void {
      listeners.set(event, fn);
    }
    catch(): void {}
    start(): Promise<void> {
      return new Promise(() => {});
    }
    async stop(): Promise<void> {}
  }
  class Plain {}
  return { listeners, FakeBot, Plain };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.Plain,
  HttpError: harness.Plain,
  InlineKeyboard: harness.Plain,
  InputFile: harness.Plain,
}));

import { TelegramChannel } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';
import { inboundDocuments } from '../src/cli.js';

async function open(chat: { id: number; type: string } = { id: 42, type: 'private' }) {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  let id = 10;
  const send = async (message: Record<string, unknown>) => {
    id += 1;
    await harness.listeners.get('message')?.({
      message: { message_id: id, date: 0, chat, ...message },
      from: { id: 7 },
      chat,
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
  };
  return { got, send, channel };
}

const doc = (fileId: string, extra: Record<string, unknown> = {}) => ({
  document: {
    file_id: fileId,
    file_unique_id: fileId,
    file_name: `${fileId}.pdf`,
    mime_type: 'application/pdf',
    file_size: 1000,
  },
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('álbum de documentos', () => {
  it('varios documentos enviados juntos llegan en un solo turno, con su texto', async () => {
    const { got, send } = await open();
    await send(doc('a', { media_group_id: 'd1' }));
    await send(doc('b', { media_group_id: 'd1' }));
    await send(doc('c', { media_group_id: 'd1', caption: 'compáralos' }));
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.documentFileId).toBe('a');
    expect(got[0]?.text).toBe('compáralos');
    expect(got[0]?.albumDocuments).toEqual([
      { fileId: 'b', mimeType: 'application/pdf', name: 'b.pdf', sizeBytes: 1000 },
      { fileId: 'c', mimeType: 'application/pdf', name: 'c.pdf', sizeBytes: 1000 },
    ]);
  });

  it('un documento suelto va como siempre, sin esperar', async () => {
    const { got, send } = await open();
    await send(doc('s'));
    expect(got.map((i) => i.documentFileId)).toEqual(['s']);
    expect(got[0]?.albumDocuments).toBeUndefined();
  });

  it('el turno lee todos los documentos del álbum, en orden', async () => {
    const { got, send } = await open();
    await send(doc('a', { media_group_id: 'd2' }));
    await send(doc('b', { media_group_id: 'd2' }));
    await vi.advanceTimersByTimeAsync(2000);
    const inbound = got[0];
    if (!inbound) throw new Error('sin turno');
    expect(inboundDocuments(inbound).map((d) => [d.fileId, d.name, d.ref])).toEqual([
      ['a', 'a.pdf', inbound.messageId],
      ['b', 'b.pdf', 'b'],
    ]);
  });

  it('sin documento no hay nada que leer', () => {
    expect(inboundDocuments({ text: 'hola', messageId: '1' } as Inbound)).toEqual([]);
  });
});
