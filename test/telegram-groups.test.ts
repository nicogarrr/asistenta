import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (ctx: unknown) => unknown>();
  class FakeBot {
    readonly api = { config: { use: () => ({}) }, setMyCommands: async () => true };
    on(event: string, fn: (ctx: unknown) => unknown): void {
      handlers.set(event, fn);
    }
    catch(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  class FakeError extends Error {}
  return { handlers, FakeBot, FakeError };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeError,
  HttpError: harness.FakeError,
  InlineKeyboard: class {},
  InputFile: class {},
}));

import { isAddressedToBot, TelegramChannel } from '../src/channels/telegram.js';

const BOT = { id: 555, username: 'asistenta_bot', is_bot: true };

async function channelWith(received: unknown[]): Promise<void> {
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (m) => void received.push(m), log: () => {} });
}

async function deliver(opts: {
  userId: number;
  chatType: 'private' | 'group' | 'supergroup';
  text: string;
  replyTo?: unknown;
}): Promise<string[]> {
  const replies: string[] = [];
  await harness.handlers.get('message')?.({
    me: BOT,
    from: { id: opts.userId, first_name: 'X' },
    chat: { id: opts.chatType === 'private' ? opts.userId : -100, type: opts.chatType },
    message: { message_id: 1, text: opts.text, reply_to_message: opts.replyTo },
    reply: async (text: string) => {
      replies.push(text);
      return {};
    },
  });
  return replies;
}

describe('Telegram en grupos', () => {
  const received: unknown[] = [];
  beforeEach(async () => {
    received.length = 0;
    harness.handlers.clear();
    await channelWith(received);
  });

  it('no contesta «privado» a cada miembro no permitido de un grupo', async () => {
    expect(await deliver({ userId: 99, chatType: 'group', text: 'hola a todos' })).toEqual([]);
    expect(
      await deliver({ userId: 99, chatType: 'supergroup', text: '@asistenta_bot hola' }),
    ).toEqual([]);
    expect(received).toHaveLength(0);
  });

  it('en privado el no permitido sigue recibiendo el aviso', async () => {
    expect(await deliver({ userId: 99, chatType: 'private', text: 'hola' })).toEqual([
      'Este asistente es privado.',
    ]);
    expect(received).toHaveLength(0);
  });

  it('responder al mensaje de OTRO bot del grupo no arranca un turno', async () => {
    await deliver({
      userId: 7,
      chatType: 'group',
      text: 'gracias',
      replyTo: { from: { id: 777, is_bot: true, username: 'otro_bot' } },
    });
    expect(received).toHaveLength(0);
    await deliver({ userId: 7, chatType: 'group', text: 'gracias', replyTo: { from: BOT } });
    expect(received).toHaveLength(1);
  });
});

describe('isAddressedToBot: mención exacta', () => {
  it('la mención no distingue mayúsculas (los usernames de Telegram no lo hacen)', () => {
    expect(isAddressedToBot('@Asistenta_Bot mira esto', {}, 'asistenta_bot', 555)).toBe(true);
  });
  it('un username más largo que empieza igual no cuenta como mención', () => {
    expect(isAddressedToBot('pregúntale a @asistenta_bot2', {}, 'asistenta_bot', 555)).toBe(false);
    expect(isAddressedToBot('ana@asistenta_bot.es', {}, 'asistenta_bot', 555)).toBe(false);
  });
  it('la respuesta solo cuenta si es a este bot', () => {
    const otro = { reply_to_message: { from: { id: 1, is_bot: true } } };
    const este = { reply_to_message: { from: { id: 555, is_bot: true } } };
    expect(isAddressedToBot('ok', otro, 'asistenta_bot', 555)).toBe(false);
    expect(isAddressedToBot('ok', este, 'asistenta_bot', 555)).toBe(true);
  });
});
