import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Un mensaje largo que se parte en trozos lleva sus botones en el ÚLTIMO trozo (justo
 * bajo el final del texto), no en el primero: antes el dueño tenía que subir para
 * aprobar. El id devuelto sigue siendo el del primer trozo. grammY falseado.
 */
const harness = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ id: number; markup: boolean }>,
    markups: [] as number[],
    nextId: 100,
  };
  class FakeBot {
    readonly api = {
      config: { use: () => ({}) },
      sendMessage: async (_chatId: number, _text: string, options?: { reply_markup?: unknown }) => {
        state.nextId += 1;
        state.sent.push({ id: state.nextId, markup: options?.reply_markup !== undefined });
        return { message_id: state.nextId };
      },
      editMessageReplyMarkup: async (_chatId: number, messageId: number) => {
        state.markups.push(messageId);
        return true;
      },
      setMyCommands: async () => true,
    };
    on(): void {}
    catch(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  class FakeInlineKeyboard {
    inline_keyboard: unknown[][] = [[]];
    row(): this {
      return this;
    }
    text(): this {
      return this;
    }
  }
  return { state, FakeBot, FakeInlineKeyboard };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: class {},
}));

import { cacheFullReply, moreButton, TelegramChannel } from '../src/channels/telegram.js';

const state = harness.state;
const long = `${'palabra '.repeat(600)}\n\n${'otra '.repeat(600)}`;
const send = async (text: string, buttons: Array<{ label: string; action: string }>) => {
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  const sending = channel.send({ channel: 'telegram', account: 'a', chatId: '7', text, buttons });
  await vi.runAllTimersAsync();
  return sending;
};

describe('botones de un mensaje largo partido en trozos', () => {
  beforeEach(() => {
    state.sent = [];
    state.markups = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('van en el último trozo y solo en él', async () => {
    try {
      await send(long, [{ label: 'Aprobar', action: 'approve:abc' }]);
    } finally {
      vi.useRealTimers();
    }
    expect(state.sent.length).toBeGreaterThan(1);
    expect(state.sent.map((s) => s.markup)).toEqual(
      state.sent.map((_, i) => i === state.sent.length - 1),
    );
  });

  it('el id devuelto sigue siendo el del primer trozo', async () => {
    let id: string | null;
    try {
      id = await send(long, [{ label: 'Aprobar', action: 'approve:abc' }]);
    } finally {
      vi.useRealTimers();
    }
    expect(id).toBe(String(state.sent[0]?.id));
  });

  it('el botón «Ver todo» se retira del trozo que lo lleva (el último)', async () => {
    try {
      cacheFullReply('hilo-trozos', 'texto completo');
      await send(long, [moreButton('hilo-trozos', '7')]);
      cacheFullReply('hilo-trozos', 'otro texto completo');
      await vi.advanceTimersByTimeAsync(5_000);
    } finally {
      vi.useRealTimers();
    }
    expect(state.markups).toEqual([state.sent[state.sent.length - 1]?.id]);
  });

  it('un mensaje corto lleva los botones en su único trozo', async () => {
    try {
      await send('Hola', [{ label: 'Aprobar', action: 'approve:abc' }]);
    } finally {
      vi.useRealTimers();
    }
    expect(state.sent).toEqual([{ id: state.nextId, markup: true }]);
  });
});
