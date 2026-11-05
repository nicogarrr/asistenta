import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Un vídeo normal se oye: su sonido va por el camino de los audios, marcado como
 * vídeo, en vez del «Aún no puedo ver vídeos». grammY falseado.
 */
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
import { VIDEO_HEARD_MARK, videoToHear, withVideoMark } from '../src/channels/telegram-video.js';
import type { Inbound } from '../src/channels/types.js';
import { voiceNotePrompt } from '../src/cli.js';

async function receive(message: Record<string, unknown>) {
  const got: Inbound[] = [];
  const replies: string[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  await harness.listeners.get('message')?.({
    message: { message_id: 5, date: 0, chat: { id: 42, type: 'private' }, ...message },
    from: { id: 7 },
    chat: { id: 42, type: 'private' },
    me: { id: 1, username: 'bot' },
    reply: async (text: string) => void replies.push(text),
  });
  await channel.stop?.();
  return { got, replies };
}

afterEach(() => harness.listeners.clear());

const video = { file_id: 'vid', duration: 40, mime_type: 'video/mp4', file_size: 3_000_000 };

describe('un vídeo se oye', () => {
  it('con pie: llega como audio del vídeo, con la marca y tu pregunta, sin aviso', async () => {
    const { got, replies } = await receive({ video, caption: '¿qué dice?' });
    expect(replies).toEqual([]);
    expect(got).toHaveLength(1);
    expect(got[0]?.audioFileId).toBe('vid');
    expect(got[0]?.audioMimeType).toBe('video/mp4');
    expect(got[0]?.audioDurationSeconds).toBe(40);
    expect(got[0]?.text).toBe(`${VIDEO_HEARD_MARK}\n¿qué dice?`);
  });

  it('sin pie también llega (antes solo había un aviso)', async () => {
    const { got, replies } = await receive({ video });
    expect(replies).toEqual([]);
    expect(got[0]?.text).toBe(VIDEO_HEARD_MARK);
  });

  it('reenviado: la marca va tras la del reenvío', async () => {
    const forward_origin = { type: 'user', sender_user: { first_name: 'Marta' } };
    const bare = await receive({ video, forward_origin });
    expect(bare.got[0]?.forwardedFrom).toMatch(/^\[Mensaje reenviado/);
    expect(bare.got[0]?.text).toBe(VIDEO_HEARD_MARK);
    const withCaption = await receive({ video, forward_origin, caption: 'mira' });
    const lines = withCaption.got[0]?.text.split('\n') ?? [];
    expect(lines[0]).toMatch(/^\[Mensaje reenviado/);
    expect(lines.slice(1)).toEqual([VIDEO_HEARD_MARK, 'mira']);
  });

  it('demasiado grande para bajarlo, en un álbum o sin duración: no se oye', () => {
    expect(videoToHear({ video: { ...video, file_size: 21 * 1024 * 1024 } })).toBeNull();
    expect(videoToHear({ video, media_group_id: 'a1' })).toBeNull();
    expect(videoToHear({ video: { ...video, duration: 0 } })).toBeNull();
    expect(videoToHear({ animation: { file_id: 'g' } })).toBeNull();
    expect(videoToHear({ video })?.file_id).toBe('vid');
  });

  it('la marca no duplica saltos ni pierde el pie', () => {
    expect(withVideoMark('')).toBe(VIDEO_HEARD_MARK);
    expect(withVideoMark('[R]\nhola', '[R]')).toBe(`[R]\n${VIDEO_HEARD_MARK}\nhola`);
  });

  it('al modelo le llega: reenvío, marca de vídeo y lo oído, en ese orden', () => {
    expect(
      voiceNotePrompt({ text: 'hola a todos' }, '[Mensaje reenviado de Marta]', VIDEO_HEARD_MARK),
    ).toBe(
      `[Mensaje reenviado de Marta]\n${VIDEO_HEARD_MARK}\n[Nota de voz transcrita] hola a todos`,
    );
  });
});
