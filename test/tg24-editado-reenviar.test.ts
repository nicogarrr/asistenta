import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Un texto editado trae en el aviso el botón «✏️ Mandar corregido»: un toque y la
 * última versión entra como mensaje nuevo, marcado como corrección. grammY falseado.
 */
const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const state = { cleared: [] as number[] };
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
      editMessageReplyMarkup: async (_chat: number, id: number) => {
        state.cleared.push(id);
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
  return { listeners, state, FakeBot, Plain };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.Plain,
  HttpError: harness.Plain,
  InlineKeyboard: harness.Plain,
  InputFile: harness.Plain,
}));

import { EDIT_RESEND_MARK, EDITED_RESEND_NOTE, TelegramChannel } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';

type Markup = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

async function setup() {
  const got: Inbound[] = [];
  const replies: Array<{ text: string; extra: { reply_markup?: Markup } }> = [];
  const answers: Array<{ text?: string } | undefined> = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  const edit = (text: string, id = 5) =>
    harness.listeners.get('edited_message')?.({
      editedMessage: {
        message_id: id,
        date: 0,
        edit_date: 10,
        chat: { id: 42, type: 'private' },
        text,
      },
      from: { id: 7, first_name: 'Nico' },
      chat: { id: 42, type: 'private' },
      me: { id: 1, username: 'bot' },
      reply: async (t: string, extra: { reply_markup?: Markup }) =>
        void replies.push({ text: t, extra }),
    });
  const press = (data: string, from = 7) =>
    harness.listeners.get('callback_query:data')?.({
      callbackQuery: { data, message: { message_id: 80, chat: { id: 42, type: 'private' } } },
      from: { id: from, username: 'nico' },
      answerCallbackQuery: async (a?: { text?: string }) => void answers.push(a),
    });
  return { got, replies, answers, channel, edit, press };
}

afterEach(() => {
  harness.listeners.clear();
  harness.state.cleared = [];
});

describe('mensaje editado: botón «Mandar corregido»', () => {
  it('el aviso de un texto editado trae el botón', async () => {
    const { replies, channel, edit } = await setup();
    await edit('recuérdame a las 10');
    expect(replies.map((r) => r.text)).toEqual([EDITED_RESEND_NOTE]);
    const button = replies[0]?.extra.reply_markup?.inline_keyboard[0]?.[0];
    expect(button?.text).toBe('✏️ Mandar corregido');
    expect(button?.callback_data).toBe('edres:5');
    await channel.stop();
  });

  it('al tocarlo entra la ÚLTIMA versión como mensaje nuevo, en el hilo del original', async () => {
    const { got, replies, answers, channel, edit, press } = await setup();
    await edit('recuérdame a las 10');
    await edit('recuérdame a las 11');
    expect(replies).toHaveLength(1);
    const data = replies[0]?.extra.reply_markup?.inline_keyboard[0]?.[0]?.callback_data ?? '';
    await press(data);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(`${EDIT_RESEND_MARK}\nrecuérdame a las 11`);
    expect(got[0]?.replyToMessageId).toBe('5');
    expect(got[0]?.messageId).toBe('80');
    expect(got[0]?.chatId).toBe('42');
    expect(answers[0]?.text).toMatch(/Mandado/);
    expect(harness.state.cleared).toContain(80);
    await channel.stop();
  });

  it('un segundo toque no lo manda dos veces', async () => {
    const { got, answers, channel, edit, press } = await setup();
    await edit('compra pan');
    await press('edres:5');
    await press('edres:5');
    expect(got).toHaveLength(1);
    expect(answers[1]?.text).toMatch(/ya no la tengo/);
    await channel.stop();
  });

  it('alguien que no es el dueño no puede mandarlo', async () => {
    const { got, channel, edit, press } = await setup();
    await edit('compra pan');
    await press('edres:5', 99);
    expect(got).toEqual([]);
    await channel.stop();
  });
});
