import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Reacciones del dueño a las respuestas del bot: un 👎 o un 🤔 llegan al asistente
 * como un mensaje que cita lo que dijo; un 👍 no abre turno. grammY falseado.
 */
const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const state = { startOptions: [] as unknown[], nextId: 100 };
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
      sendMessage: async () => {
        state.nextId += 1;
        return { message_id: state.nextId };
      },
    };
    on(event: string, fn: (ctx: unknown) => unknown): void {
      listeners.set(event, fn);
    }
    catch(): void {}
    start(options?: unknown): Promise<void> {
      state.startOptions.push(options);
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

import { TelegramChannel } from '../src/channels/telegram.js';
import { addedEmojis, reactionMood, reactionText } from '../src/channels/telegram-reacciones.js';
import type { Inbound } from '../src/channels/types.js';

const emoji = (e: string) => ({ type: 'emoji', emoji: e });

async function setup() {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  const id = await channel.send({
    channel: 'telegram',
    account: 'main',
    chatId: '42',
    threadId: '9',
    text: 'El vuelo a Roma sale a las 7:40 desde Barajas.',
  });
  const react = async (
    messageId: number,
    added: string[],
    opts: { userId?: number; old?: string[] } = {},
  ) =>
    harness.listeners.get('message_reaction')?.({
      messageReaction: {
        chat: { id: 42, type: 'private' },
        message_id: messageId,
        user: { id: opts.userId ?? 7, first_name: 'Nico' },
        date: 1_700_000_000,
        old_reaction: (opts.old ?? []).map(emoji),
        new_reaction: [...(opts.old ?? []), ...added].map(emoji),
      },
    });
  return { got, channel, id: Number(id), react };
}

afterEach(() => {
  harness.listeners.clear();
  harness.state.startOptions = [];
});

describe('reacciones a las respuestas del bot', () => {
  it('pide a Telegram las reacciones (no llegan por defecto) sin perder lo demás', async () => {
    const { channel } = await setup();
    const opts = harness.state.startOptions[0] as { allowed_updates?: string[] };
    expect(opts.allowed_updates).toEqual(
      expect.arrayContaining(['message', 'edited_message', 'callback_query', 'message_reaction']),
    );
    await channel.stop();
  });

  it('un 👎 a una respuesta llega al asistente citándola, en su hilo', async () => {
    const { got, channel, id, react } = await setup();
    await react(id, ['👎']);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toContain('[Reacción 👎 a tu mensaje «El vuelo a Roma sale a las 7:40');
    expect(got[0]?.text).toMatch(/corrígela/);
    expect(got[0]?.messageId).toBe(String(id));
    expect(got[0]?.replyToMessageId).toBe(String(id));
    expect(got[0]?.threadId).toBe('9');
    expect(got[0]?.userId).toBe('7');
    await channel.stop();
  });

  it('un 👍 o un ❤️ no abre turno', async () => {
    const { got, channel, id, react } = await setup();
    await react(id, ['👍']);
    await react(id, ['❤️'], { old: ['👍'] });
    expect(got).toEqual([]);
    await channel.stop();
  });

  it('una vez por mensaje: un 🤔 después del 👎 no repite el turno', async () => {
    const { got, channel, id, react } = await setup();
    await react(id, ['👎']);
    await react(id, ['🤔'], { old: [] });
    expect(got).toHaveLength(1);
    await channel.stop();
  });

  it('quien no es el dueño, o un mensaje que no es del bot, no hace nada', async () => {
    const { got, channel, id, react } = await setup();
    await react(id, ['👎'], { userId: 99 });
    await react(5, ['👎']);
    expect(got).toEqual([]);
    await channel.stop();
  });
});

describe('lectura de las reacciones', () => {
  it('solo cuentan los emojis recién puestos, con o sin selector de variante', () => {
    expect(addedEmojis([emoji('❤')], [emoji('❤️'), emoji('👎')])).toEqual(['👎']);
    expect(addedEmojis([emoji('👎')], [])).toEqual([]);
    expect(addedEmojis([], [{ type: 'custom_emoji' }, { type: 'paid' }])).toEqual([]);
  });

  it('clasifica duda y rechazo frente a aprobación', () => {
    expect(reactionMood('👎')).toBe('negativa');
    expect(reactionMood('🤔')).toBe('negativa');
    expect(reactionMood('❤️')).toBe('positiva');
    expect(reactionMood('👍')).toBe('positiva');
    expect(reactionMood('👀')).toBe('otra');
  });

  it('la cita se recorta y no rompe las comillas', () => {
    const text = reactionText('👎', `di «hola» ${'x'.repeat(400)}`);
    expect(text.startsWith('[Reacción 👎 a tu mensaje «di "hola" x')).toBe(true);
    expect(text).toContain('…»');
  });
});
