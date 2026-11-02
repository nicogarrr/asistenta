/**
 * Varios audios enviados de una vez (mismo media_group_id) eran un turno por audio: «¿de
 * qué hablan?» se contestaba con solo el primero y cada uno tenía su respuesta suelta.
 * Ahora van en un turno, como los álbumes de fotos y documentos: se transcriben todos,
 * numerados, y uno que falla se dice sin tumbar los demás. Bot API falsa, relojes falsos.
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
import { receiptKind, receiptStartText } from '../src/channels/telegram-receipts.js';
import type { Inbound } from '../src/channels/types.js';
import { albumHeard, transcribeAlbumAudios, voiceNotePrompt } from '../src/cli.js';

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

const audio = (fileId: string, extra: Record<string, unknown> = {}) => ({
  audio: { file_id: fileId, file_unique_id: fileId, duration: 5, mime_type: 'audio/mpeg' },
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('álbum de audios', () => {
  it('varios audios enviados juntos llegan en un solo turno, con su texto', async () => {
    const { got, send } = await open();
    await send(audio('a', { media_group_id: 'au1' }));
    await send(audio('b', { media_group_id: 'au1' }));
    await send(audio('c', { media_group_id: 'au1', caption: '¿de qué hablan?' }));
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.audioFileId).toBe('a');
    expect(got[0]?.text).toBe('¿de qué hablan?');
    expect(got[0]?.albumAudios?.map((x) => x.fileId)).toEqual(['b', 'c']);
  });

  it('un audio suelto va como siempre, sin esperar', async () => {
    const { got, send } = await open();
    await send(audio('s'));
    expect(got.map((i) => i.audioFileId)).toEqual(['s']);
    expect(got[0]?.albumAudios).toBeUndefined();
  });

  it('el acuse cuenta los audios', () => {
    const inbound = { audioFileId: 'a', albumAudios: [{ fileId: 'b' }, { fileId: 'c' }] };
    const kind = receiptKind(inbound);
    expect(kind && receiptStartText(kind, inbound)).toBe('🎧 Transcribiendo los 3 audios…');
  });

  it('se transcriben todos; uno que falla se dice y no tumba los demás', async () => {
    const rest = await transcribeAlbumAudios(
      [{ fileId: 'b' }, { fileId: 'c' }, { fileId: 'd' }],
      async (id) => (id === 'c' ? null : Buffer.from(id)),
      async (bytes) => {
        if (bytes.toString() === 'd') throw new Error('roto');
        return { text: `texto ${bytes.toString()}` };
      },
    );
    const heard = albumHeard({ text: 'texto a' }, rest);
    expect(heard.text).toBe(
      '(1/4) texto a\n(2/4) texto b\n(3/4) [no se pudo descargar]\n(4/4) [no se pudo transcribir]',
    );
    expect(voiceNotePrompt(heard, undefined, '¿de qué hablan?')).toBe(
      `¿de qué hablan?\n[4 audios transcritos] ${heard.text}`,
    );
  });
});
