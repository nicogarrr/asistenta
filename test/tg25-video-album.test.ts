import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Un vídeo dentro de un álbum también se oye (antes solo el vídeo suelto): su sonido
 * va con el álbum, marcado como vídeo, sin el aviso «Aún no puedo ver vídeos». Y los
 * avisos de error de un vídeo dicen «vídeo», no «audio» ni «nota de voz». grammY falseado.
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

import { readFileSync } from 'node:fs';
import { TelegramChannel } from '../src/channels/telegram.js';
import { voiceHeardText } from '../src/channels/telegram-receipts.js';
import { VIDEO_HEARD_MARK, videoToHear } from '../src/channels/telegram-video.js';
import type { Inbound } from '../src/channels/types.js';
import { albumHeard } from '../src/cli.js';

async function open() {
  const got: Inbound[] = [];
  const replies: string[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  let id = 10;
  const chat = { id: 42, type: 'private' };
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
  return { got, replies, send };
}

const photo = (fileId: string, extra: Record<string, unknown> = {}) => ({
  photo: [{ file_id: fileId, file_unique_id: fileId, width: 1, height: 1 }],
  ...extra,
});
const video = (fileId: string, extra: Record<string, unknown> = {}) => ({
  video: {
    file_id: fileId,
    file_unique_id: fileId,
    width: 1,
    height: 1,
    duration: 12,
    mime_type: 'video/mp4',
    file_size: 2_000_000,
  },
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('vídeo dentro de un álbum', () => {
  it('se oye: foto + vídeo con pie es un turno con su sonido, sin aviso', async () => {
    const { got, replies, send } = await open();
    await send(photo('a', { media_group_id: 'g1', caption: '¿qué dicen en el vídeo?' }));
    await send(video('v', { media_group_id: 'g1' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(replies).toEqual([]);
    expect(got).toHaveLength(1);
    expect(got[0]?.photoFileId).toBe('a');
    expect(got[0]?.audioFileId).toBe('v');
    expect(got[0]?.audioMimeType).toBe('video/mp4');
    expect(got[0]?.audioIsVideo).toBe(true);
    expect(got[0]?.albumVideos).toBeUndefined();
    expect(got[0]?.text).toBe(`${VIDEO_HEARD_MARK}\n¿qué dicen en el vídeo?`);
  });

  it('un álbum solo de vídeos sin texto ya tiene turno: los dos se oyen', async () => {
    const { got, replies, send } = await open();
    await send(video('v', { media_group_id: 'g2' }));
    await send(video('w', { media_group_id: 'g2' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(replies).toEqual([]);
    expect(got).toHaveLength(1);
    expect(got[0]?.audioFileId).toBe('v');
    expect(got[0]?.audioIsVideo).toBe(true);
    expect(got[0]?.albumAudios?.map((a) => [a.fileId, a.video])).toEqual([['w', true]]);
    // Con varios sonidos la marca va en cada línea oída, no en el texto.
    expect(got[0]?.text).toBe('');
  });

  it('con un GIF además: un aviso por el GIF, pero los vídeos se oyen igual', async () => {
    const { got, replies, send } = await open();
    await send(video('v', { media_group_id: 'g3' }));
    await send({ animation: { file_id: 'gif', file_unique_id: 'gif' }, media_group_id: 'g3' });
    await send(video('w', { media_group_id: 'g3' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(replies).toHaveLength(1);
    expect(got).toHaveLength(1);
    expect(got[0]?.audioFileId).toBe('v');
    expect(got[0]?.albumVideos).toBe(1);
  });

  it('un vídeo de más de 20 MB en un álbum sigue sin oírse', () => {
    const big = video('v', { media_group_id: 'g4' });
    expect(videoToHear(big)?.file_id).toBe('v');
    expect(
      videoToHear({ ...big, video: { ...big.video, file_size: 30 * 1024 * 1024 } }),
    ).toBeNull();
  });
});

describe('lo oído y los avisos dicen «vídeo»', () => {
  it('cada línea oída de un vídeo lo dice', () => {
    const heard = albumHeard(
      { text: 'hola' },
      [
        { audio: { fileId: 'w', video: true }, heard: { text: 'adiós' } },
        { audio: { fileId: 'x' }, heard: { text: 'nota' } },
      ],
      true,
    );
    expect(heard.text).toBe(
      '(1/3, sonido de un vídeo) hola\n(2/3, sonido de un vídeo) adiós\n(3/3) nota',
    );
  });

  it('un vídeo sin palabras no dice «no he entendido»', () => {
    expect(voiceHeardText('', true)).toBe('🎬 No he oído palabras en el vídeo.');
    expect(voiceHeardText('')).toBe('🎙️ No he entendido ninguna palabra.');
  });

  it('descargar u oír un vídeo que falla avisa del vídeo', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain("const what = inbound.audioIsVideo ? 'el vídeo' : 'el audio';");
    expect(src).toMatch(/`No he podido descargar \$\{what\}\.`/);
    expect(src).toContain(
      "inbound.audioIsVideo ? 'No he podido oír el vídeo' : 'No he entendido la nota de voz'",
    );
  });
});
