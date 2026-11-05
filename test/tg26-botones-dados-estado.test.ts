import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * tg-26: botones viejos fuera al contestar escribiendo, dados como texto, aviso de
 * álbum matizado cuando otro vídeo sí se oyó y contador de reacciones en /estado.
 * grammY falseado.
 */
const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const state = {
    markups: [] as Array<[number, number, unknown]>,
    nextId: 500,
  };
  class FakeKeyboard {
    rows: Array<Array<{ text: string; callback_data: string }>> = [[]];
    text(label: string, data: string): this {
      this.rows[this.rows.length - 1]?.push({ text: label, callback_data: data });
      return this;
    }
    row(): this {
      this.rows.push([]);
      return this;
    }
  }
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
      sendMessage: async () => ({ message_id: state.nextId++ }),
      editMessageReplyMarkup: async (c: number, m: number, extra: unknown) => {
        state.markups.push([c, m, extra]);
        return true;
      },
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
  return { listeners, state, FakeBot, FakeKeyboard, Plain };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.Plain,
  HttpError: harness.Plain,
  InlineKeyboard: harness.FakeKeyboard,
  InputFile: harness.Plain,
}));

import {
  ALBUM_VIDEO_NOTE,
  ALBUM_VIDEO_PARTIAL_NOTE,
  hasOpenQuickReply,
  TelegramChannel,
} from '../src/channels/telegram.js';
import { diceText } from '../src/channels/telegram-compartido.js';
import { quickReplyButtons } from '../src/channels/telegram-respuestas.js';
import type { Inbound } from '../src/channels/types.js';
import { formatStatus, summarizeLog } from '../src/status.js';

afterEach(() => {
  harness.listeners.clear();
  harness.state.markups = [];
  vi.useRealTimers();
});

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
  return { channel, got, replies, send };
}

describe('botones «¿A o B?» / «Sí/No» viejos', () => {
  it('se quitan cuando Nico contesta escribiendo, una sola vez', async () => {
    const { channel, send } = await open();
    await channel.send({
      channel: 'telegram',
      chatId: '42',
      text: '¿Hoy o mañana?',
      buttons: quickReplyButtons('¿Hoy o mañana?') ?? [],
    } as never);
    await send({ text: 'mejor el viernes' });
    await vi.waitFor(
      () =>
        expect(harness.state.markups).toEqual([
          [42, 500, { reply_markup: { inline_keyboard: [] } }],
        ]),
      { timeout: 4000 },
    );
    await send({ text: 'y otra cosa' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(harness.state.markups).toHaveLength(1);
  });

  it('una respuesta sin botones de respuesta rápida no deja nada que quitar', async () => {
    const { channel, send } = await open();
    await channel.send({ channel: 'telegram', chatId: '42', text: 'Hecho.' } as never);
    await send({ text: 'gracias' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(harness.state.markups).toEqual([]);
    expect(hasOpenQuickReply([{ action: 'qr:hecho' }])).toBe(false);
    expect(hasOpenQuickReply([{ action: 'qr:si' }, { action: 'qr:no' }])).toBe(true);
    expect(hasOpenQuickReply([{ action: 'cmd:vigila' }])).toBe(false);
  });
});

describe('dados de Telegram como texto', () => {
  it('el resultado llega al asistente en vez de «Aún no juego a los dados»', async () => {
    const { got, replies, send } = await open();
    await send({ dice: { emoji: '🎲', value: 3 } });
    expect(replies).toEqual([]);
    expect(got.map((i) => i.text)).toEqual(['[Dado 🎲: salió un 3]']);
    expect(diceText({ dice: { emoji: '🎯', value: 6 } })).toBe('[Dardo 🎯: en el centro]');
    expect(diceText({ dice: { emoji: '⚽', value: 2 } })).toBe('[Penalti ⚽: fallado]');
    expect(diceText({ dice: { emoji: '🎲', value: 0 } })).toBeNull();
    expect(diceText({ text: 'hola' })).toBeNull();
  });
});

describe('álbum con un vídeo que sí se oye y otro demasiado grande', () => {
  const video = (fileId: string, size: number) => ({
    video: {
      file_id: fileId,
      file_unique_id: fileId,
      width: 1,
      height: 1,
      duration: 12,
      mime_type: 'video/mp4',
      file_size: size,
    },
    media_group_id: 'g9',
  });

  it('el aviso no dice «no puedo ver vídeos» si otro vídeo se oyó', async () => {
    vi.useFakeTimers();
    const { got, replies, send } = await open();
    await send(video('ok', 2_000_000));
    await send(video('big', 30 * 1024 * 1024));
    await vi.advanceTimersByTimeAsync(2000);
    expect(replies).toEqual([ALBUM_VIDEO_PARTIAL_NOTE]);
    expect(got).toHaveLength(1);
    expect(got[0]?.audioFileId).toBe('ok');
  });

  it('sin ningún vídeo oído sigue el aviso de siempre', async () => {
    vi.useFakeTimers();
    const { replies, send } = await open();
    await send({
      photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }],
      media_group_id: 'g9',
      caption: 'mira',
    });
    await send(video('big', 30 * 1024 * 1024));
    await vi.advanceTimersByTimeAsync(2000);
    expect(replies).toEqual([ALBUM_VIDEO_NOTE]);
  });
});

describe('/estado cuenta las reacciones de hoy', () => {
  it('👍 y 👎 desde el log del día, sin leer sus campos', () => {
    const line = (level: string, msg: string) => JSON.stringify({ level, msg, emoji: 'x' });
    const log = [
      line('info', '[telegram] telegram reaction'),
      line('info', '[telegram] telegram reaction'),
      line('info', '[telegram] telegram reaction negativa'),
      line('warn', 'otra cosa'),
    ].join('\n');
    const summary = summarizeLog(log);
    expect(summary.reactions).toEqual({ positive: 2, negative: 1 });
    const text = formatStatus({
      version: '1',
      node: 'v24',
      uptimeMs: 1000,
      tools: [],
      log: summary,
      pageWatches: 0,
    });
    expect(text).toContain('Tus reacciones de hoy: 👍 2 · 👎 1 (las revisé).');
    expect(summarizeLog(line('info', 'nada')).reactions).toBeUndefined();
  });
});
