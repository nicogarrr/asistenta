/**
 * Un álbum con fotos y un vídeo llega de Telegram como un mensaje por elemento con el
 * mismo media_group_id. Desde #1807 las fotos van juntas en un turno, pero el vídeo
 * seguía recibiendo su propio aviso suelto («Aún no puedo ver vídeos…») como si fuera
 * otro mensaje. Ahora se une al álbum: un turno, un solo aviso, y el modelo sabe que
 * había un vídeo que no vio. Bot API falsa, relojes falsos.
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

import { ALBUM_VIDEO_NOTE, TelegramChannel } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';
import { albumVideosNote } from '../src/cli.js';

async function open(chat: { id: number; type: string } = { id: 42, type: 'private' }) {
  const got: Inbound[] = [];
  const replies: string[] = [];
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
      reply: async (text: string) => {
        replies.push(text);
      },
    });
  };
  return { got, replies, send, channel };
}

const photo = (fileId: string, extra: Record<string, unknown> = {}) => ({
  photo: [{ file_id: fileId, file_unique_id: fileId, width: 1, height: 1 }],
  ...extra,
});
const video = (fileId: string, extra: Record<string, unknown> = {}) => ({
  video: { file_id: fileId, file_unique_id: fileId, width: 1, height: 1, duration: 3 },
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('álbum con vídeo', () => {
  it('el vídeo se une al álbum de fotos: un turno y un solo aviso', async () => {
    const { got, replies, send } = await open();
    await send(photo('a', { media_group_id: 'v1', caption: '¿qué tal salieron?' }));
    await send(video('v', { media_group_id: 'v1' }));
    await send(photo('b', { media_group_id: 'v1' }));
    expect(got).toHaveLength(0);
    expect(replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.photoFileId).toBe('a');
    expect(got[0]?.albumPhotoFileIds).toEqual(['b']);
    expect(got[0]?.albumVideos).toBe(1);
    expect(got[0]?.text).toBe('¿qué tal salieron?');
    expect(replies).toEqual([ALBUM_VIDEO_NOTE]);
  });

  it('si el álbum empieza por un vídeo con texto, la primera foto pasa a ser la principal', async () => {
    const { got, replies, send } = await open();
    await send(video('v', { media_group_id: 'v2', caption: 'mira' }));
    await send(video('w', { media_group_id: 'v2' }));
    await send(photo('a', { media_group_id: 'v2' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.photoFileId).toBe('a');
    expect(got[0]?.albumPhotoFileIds).toBeUndefined();
    expect(got[0]?.albumVideos).toBe(2);
    expect(got[0]?.text).toBe('mira');
    expect(replies).toEqual([ALBUM_VIDEO_NOTE]);
  });

  it('un álbum solo de vídeos sin texto: un aviso y ningún turno', async () => {
    const { got, replies, send } = await open();
    await send(video('v', { media_group_id: 'v3' }));
    await send(video('w', { media_group_id: 'v3' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(0);
    expect(replies).toEqual([ALBUM_VIDEO_NOTE]);
  });

  it('un vídeo suelto sigue con su aviso de siempre', async () => {
    const { got, replies, send } = await open();
    await send(video('v'));
    expect(got).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('vídeos');
  });

  it('el modelo sabe que no vio los vídeos del álbum', () => {
    expect(albumVideosNote(1)).toContain('un vídeo o GIF que no puedo ver');
    expect(albumVideosNote(2)).toContain('2 vídeos o GIF que no puedo ver');
  });
});
