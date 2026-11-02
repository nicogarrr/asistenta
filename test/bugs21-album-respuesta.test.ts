/**
 * Responder a la 2.ª foto (o al 2.º audio) de un álbum: el turno quedaba ligado solo al
 * message_id de la primera pieza, así que la respuesta caía en otra conversación y «/play»
 * respondiendo al 2.º audio soltaba el último en vez de ese. Ahora cada pieza apunta al
 * hilo del álbum y cada audio se recuerda con su propio message_id. Bot API falsa.
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
import { beginInbound, linkAlbumPieces } from '../src/daemon/inbound.js';
import { AudioRecall } from '../src/media/recall.js';

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

const photo = (fileId: string, extra: Record<string, unknown> = {}) => ({
  photo: [{ file_id: fileId, file_unique_id: fileId, width: 10, height: 10 }],
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('respuesta a una pieza de un álbum', () => {
  it('el álbum lleva los message_id del resto de piezas', async () => {
    const { got, send } = await open();
    await send(photo('p1', { media_group_id: 'g1' }));
    await send(photo('p2', { media_group_id: 'g1' }));
    await send(photo('p3', { media_group_id: 'g1', caption: 'mira' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.messageId).toBe('11');
    expect(got[0]?.albumMessageIds).toEqual(['12', '13']);
  });

  it('cada pieza apunta al hilo del turno: responder a la 2.ª sigue esa conversación', () => {
    const map = new Map<string, string>();
    linkAlbumPieces(map, 'telegram:42', { albumMessageIds: ['12', '13'] }, 'telegram:42#m11');
    expect(map.get('telegram:42:12')).toBe('telegram:42#m11');
    expect(map.get('telegram:42:13')).toBe('telegram:42#m11');
    linkAlbumPieces(map, 'telegram:42', {}, 'x');
    expect(map.size).toBe(2);
  });

  it('cada audio del álbum se recuerda con su message_id: /play respondiendo al 2.º es ese', async () => {
    const { got, send } = await open();
    await send(audio('a', { media_group_id: 'au1' }));
    await send(audio('b', { media_group_id: 'au1' }));
    await send(audio('c', { media_group_id: 'au1' }));
    await vi.advanceTimersByTimeAsync(2000);
    const inbound = got[0] as Inbound;
    expect(inbound.albumAudios?.map((x) => x.messageId)).toEqual(['12', '13']);
    const recall = new AudioRecall();
    beginInbound(inbound, 'telegram:42', {
      seen: new Map(),
      log: { info: () => {} },
      emitMessageTrigger: async () => {},
      setLastChat: () => {},
      recordAudio: (key: string, a: Parameters<AudioRecall['record']>[1]) => {
        recall.record(key, a);
      },
    } as never);
    expect(recall.resolve('telegram:42', { replyTo: '12' })?.fileId).toBe('b');
    expect(recall.resolve('telegram:42', { replyTo: '11' })?.fileId).toBe('a');
    expect(recall.last('telegram:42')?.fileId).toBe('c');
  });
});
