/**
 * En un grupo, Telegram pone el texto de un álbum en la foto que el usuario eligió, no
 * siempre en la primera. Si la mención («@bot compáralas») iba en la segunda foto, la
 * primera llegaba sin mención y se descartaba: el turno veía solo una foto de tres.
 * Ahora el álbum entero se retiene y sale si alguna de sus piezas va dirigida al bot.
 * Bot API falsa, relojes falsos.
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

const replies: string[] = [];

async function open(chat: { id: number; type: string } = { id: -42, type: 'supergroup' }) {
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
      reply: async (t: string) => void replies.push(t),
    });
  };
  return { got, send, channel };
}

const photo = (fileId: string, extra: Record<string, unknown> = {}) => ({
  photo: [{ file_id: fileId, file_unique_id: fileId, width: 1, height: 1 }],
  ...extra,
});
const video = (fileId: string, extra: Record<string, unknown> = {}) => ({
  video: { file_id: fileId, file_unique_id: fileId, width: 1, height: 1, duration: 1 },
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  replies.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('álbum en un grupo con la mención en una foto posterior', () => {
  it('las fotos anteriores a la mención no se pierden', async () => {
    const { got, send } = await open();
    await send(photo('a', { media_group_id: 'm1' }));
    await send(photo('b', { media_group_id: 'm1', caption: '@bot compáralas' }));
    await send(photo('c', { media_group_id: 'm1' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.photoFileId).toBe('a');
    expect(got[0]?.albumPhotoFileIds).toEqual(['b', 'c']);
    expect(got[0]?.text).toBe('@bot compáralas');
  });

  it('un álbum sin ninguna mención sigue sin turno ni respuesta', async () => {
    const { got, send } = await open();
    await send(photo('a', { media_group_id: 'm2' }));
    await send(video('v', { media_group_id: 'm2' }));
    await send(photo('b', { media_group_id: 'm2', caption: 'mirad qué playa' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(0);
    expect(replies).toEqual([]);
  });

  it('un álbum sin mención no arrastra la mención de otro álbum', async () => {
    const { got, send } = await open();
    await send(photo('x', { media_group_id: 'm3' }));
    await send(photo('a', { media_group_id: 'm4', caption: '@bot mira' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.photoFileId)).toEqual(['a']);
    expect(got[0]?.albumPhotoFileIds).toBeUndefined();
  });

  it('en privado todo sigue igual', async () => {
    const { got, send } = await open({ id: 42, type: 'private' });
    await send(photo('a', { media_group_id: 'm5' }));
    await send(photo('b', { media_group_id: 'm5', caption: 'compáralas' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.albumPhotoFileIds).toEqual(['b']);
  });
});
