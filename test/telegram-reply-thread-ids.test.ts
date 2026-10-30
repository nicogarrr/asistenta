import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Responder a cualquier trozo de una respuesta larga (también del texto completo
 * pedido con «más» escrito) sigue la conversación que la produjo: cada id que
 * devuelve Telegram se apunta al hilo. Antes solo el primero de una respuesta normal
 * y ninguno del «más» escrito. grammY falseado; la cola de mensajes devuelve ids 1, 2…
 */
const harness = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ text: string; parseMode?: string }>,
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
      sendMessage: async (_chatId: number, text: string, options?: { parse_mode?: string }) => {
        if (options?.parse_mode && state.htmlErrors.length) {
          throw new FakeGrammyError(400, state.htmlErrors.shift() as string);
        }
        state.sent.push({ text, parseMode: options?.parse_mode });
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

import { readFileSync } from 'node:fs';
import { TelegramChannel } from '../src/channels/telegram.js';
import { threadForSentIds } from '../src/daemon/inbound.js';

const channel = () => new TelegramChannel({ token: 't', allowedUserIds: [7] });
const state = harness.state;

describe('hilo de cada trozo enviado', () => {
  beforeEach(() => {
    state.sent = [];
    state.htmlErrors = [];
  });

  it('un texto de 3 trozos apunta los 3 ids al hilo', async () => {
    const map = new Map<string, string>();
    const long = Array.from({ length: 3 }, (_, i) => `${String(i).repeat(3900)}`).join('\n');
    // El canal espacia los trozos ~1,1 s: con reloj falso no se duerme de verdad.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const t0 = performance.now();
    try {
      const sending = channel().send(
        { channel: 'telegram', account: 'a', chatId: '7', text: long, format: 'marks' },
        threadForSentIds(map, 'telegram:dm:7', 'hilo-B'),
      );
      await vi.runAllTimersAsync();
      await sending;
    } finally {
      vi.useRealTimers();
    }
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(state.sent.length).toBe(3);
    expect([...map.entries()]).toEqual([
      ['telegram:dm:7:1', 'hilo-B'],
      ['telegram:dm:7:2', 'hilo-B'],
      ['telegram:dm:7:3', 'hilo-B'],
    ]);
  });

  it('cli.ts pasa onSent en el «más» escrito y en la respuesta normal', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/\.send\(\s*\{[\s\S]{0,800}?\},\s*opts\.onSent,\s*\)/);
    const more = src.slice(src.indexOf('const full = cachedFullReply('));
    expect(more.slice(0, 900)).toContain(
      'onSent: threadForSentIds(messageThread, chatKey(inbound), thread.key)',
    );
    const reply = src.slice(src.indexOf('const id = await say(inbound, short.text'));
    expect(reply.slice(0, 400)).toContain('onSent: threadForSentIds(');
  });
});
