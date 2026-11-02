import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Telegram mide el límite de 4096 caracteres en unidades UTF-16 (un emoji como 👍🏽
 * cuenta 4), no en puntos de código. Una respuesta llena de emojis troceada a 4000
 * puntos de código superaba las 4096 unidades y Telegram la rechazaba con
 * «message is too long». Bot API falsa: sin token ni red.
 */
const harness = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ text: string; parseMode?: string; markup?: unknown; reply?: number }>,
    /** Descripciones de 400 que el próximo sendMessage con parse_mode debe lanzar. */
    htmlErrors: [] as string[],
  };
  class FakeGrammyError extends Error {
    readonly error_code: number;
    readonly description: string;
    constructor(errorCode: number, description: string) {
      super(description);
      this.error_code = errorCode;
      this.description = description;
    }
  }
  class FakeBot {
    readonly api = {
      config: { use: () => ({}) },
      sendMessage: async (
        _chatId: number,
        text: string,
        options?: { parse_mode?: string; reply_markup?: unknown; reply_to_message_id?: number },
      ) => {
        if (options?.parse_mode && state.htmlErrors.length) {
          throw new FakeGrammyError(400, state.htmlErrors.shift() as string);
        }
        state.sent.push({
          text,
          parseMode: options?.parse_mode,
          markup: options?.reply_markup,
          reply: options?.reply_to_message_id,
        });
        return { message_id: state.sent.length };
      },
      setMyCommands: async () => true,
    };
    on(): void {}
    catch(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  class FakeInlineKeyboard {
    row(): this {
      return this;
    }
    text(): this {
      return this;
    }
  }
  return { state, FakeBot, FakeGrammyError, FakeInlineKeyboard };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeGrammyError,
  HttpError: class extends Error {},
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: class {},
}));

import { cleanForTelegram } from '../src/channels/formatters.js';
import { chunkText, TelegramChannel } from '../src/channels/telegram.js';

const LIMIT = 4096;
const state = harness.state;
const channel = () => new TelegramChannel({ token: 't', allowedUserIds: [7] });
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

async function send(text: string): Promise<void> {
  await channel().send({
    channel: 'telegram',
    account: 'a',
    chatId: '7',
    text: cleanForTelegram(text),
    format: 'marks',
  });
}

describe('troceo de Telegram en unidades UTF-16 (emojis)', () => {
  beforeEach(() => {
    state.sent.length = 0;
  });
  afterEach(() => {
    state.sent.length = 0;
  });

  it('una respuesta llena de emojis cabe en cada mensaje tal como lo cuenta Telegram', async () => {
    const text = Array.from({ length: 900 }, (_, i) => `👍🏽 ítem ${i} ✅`).join(' ');
    await send(text);
    expect(state.sent.length).toBeGreaterThan(1);
    for (const m of state.sent) {
      expect(m.text).not.toMatch(LONE_SURROGATE);
      // .length de JS = unidades UTF-16, lo que cuenta Telegram.
      expect(visible(m.text).length).toBeLessThanOrEqual(LIMIT);
    }
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    expect(words(state.sent.map((m) => visible(m.text)).join(' '))).toEqual(words(text));
  });

  it('solo emojis sin espacios: trozos de como mucho 4000 unidades, sin medio emoji', () => {
    const parts = chunkText('😀'.repeat(3000), 4000, { utf16: true });
    expect(parts.join('')).toBe('😀'.repeat(3000));
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(4000);
      expect(p).not.toMatch(LONE_SURROGATE);
    }
  });

  it('sin la opción, el troceo sigue contando puntos de código (otros usos no cambian)', () => {
    expect(chunkText('a😀b', 2)).toEqual(['a😀', 'b']);
    expect(chunkText('a😀b', 2, { utf16: true })).toEqual(['a', '😀', 'b']);
  });
});
