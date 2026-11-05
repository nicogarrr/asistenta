/**
 * Cita parcial: en Telegram se puede seleccionar un trozo de un mensaje y responder solo a
 * ese trozo (`quote`). Antes el asistente recibía el mensaje entero y contestaba sobre
 * todo; ahora le llega «[Responde en concreto a esta parte: «…»]», también cuando el
 * mensaje respondido ya está en la conversación. Y una respuesta a un mensaje de OTRO
 * chat (`external_reply`) dice de quién era. Bot API falsa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { withReplyQuote } from '../src/cli.js';
import { mergeBatchedInbounds } from '../src/daemon/inbound.js';

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

const ana = { id: 9, is_bot: false, first_name: 'Ana' };
const botMsg = {
  message_id: 3,
  date: 0,
  chat: { id: 42, type: 'private' },
  from: { id: 1, is_bot: true, first_name: 'Bot' },
  text: 'Opciones: 1) Prado 2) Retiro 3) Templo de Debod',
};

describe('cita parcial en Telegram', () => {
  it('la respuesta a un trozo citado lleva ese trozo, aparte de la cita entera', async () => {
    const r = await receive({
      text: '¿y esta a qué hora abre?',
      reply_to_message: botMsg,
      quote: { text: '2) Retiro', position: 23 },
    });
    expect(r.got[0]?.text).toBe('¿y esta a qué hora abre?');
    expect(r.got[0]?.replyQuotePart).toBe('[Responde en concreto a esta parte: «2) Retiro»]');
    expect(r.got[0]?.replyQuote).toBe(
      '[Respondiendo a tu mensaje: «Opciones: 1) Prado 2) Retiro 3) Templo de Debod»]',
    );
  });

  it('sin trozo citado no hay nota; un trozo largo se corta en una línea', async () => {
    const plain = await receive({ text: 'vale', reply_to_message: botMsg });
    expect(plain.got[0]?.replyQuotePart).toBeUndefined();
    const long = await receive({
      text: 'esto',
      reply_to_message: botMsg,
      quote: { text: `${'b'.repeat(299)}\n😀 más` },
    });
    expect(long.got[0]?.replyQuotePart).toBe(
      `[Responde en concreto a esta parte: «${'b'.repeat(299)}…»]`,
    );
  });

  it('el trozo llega al modelo aunque el mensaje respondido ya esté en la conversación', () => {
    const q = '[Respondiendo a tu mensaje: «1) Prado 2) Retiro»]';
    const part = '[Responde en concreto a esta parte: «2) Retiro»]';
    expect(withReplyQuote('¿horario?', q, true, part)).toBe(`${part}\n¿horario?`);
    expect(withReplyQuote('¿horario?', q, false, part)).toBe(`${q}\n${part}\n¿horario?`);
    expect(withReplyQuote('¿horario?', q, true)).toBe('¿horario?');
  });

  it('en una tanda de mensajes, cada trozo citado va en su pieza', () => {
    const base = { channel: 'telegram', chatId: '42', userId: '7', receivedAt: '' } as const;
    const merged = mergeBatchedInbounds(
      [
        { ...base, messageId: '1', text: 'mira' },
        {
          ...base,
          messageId: '2',
          text: '¿y esta?',
          replyToMessageId: '3',
          replyQuote: '[Respondiendo a tu mensaje: «1) Prado 2) Retiro»]',
          replyQuotePart: '[Responde en concreto a esta parte: «2) Retiro»]',
        },
      ] as Inbound[],
      { linked: () => true, time: () => '' },
    );
    expect(merged.text).toContain('[Responde en concreto a esta parte: «2) Retiro»]\n¿y esta?');
    expect(merged.text).not.toContain('Respondiendo a tu mensaje');
    expect(merged.replyQuotePart).toBeUndefined();
  });

  it('respuesta a un mensaje de otro chat: dice de quién era y el trozo citado', async () => {
    const r = await receive({
      text: '¿qué opinas?',
      external_reply: { origin: { type: 'user', date: 0, sender_user: ana }, chat: { id: 99 } },
      quote: { text: 'el viernes cerramos' },
    });
    expect(r.got[0]?.replyQuote).toBe('[Respondiendo a un mensaje de Ana de otro chat]');
    expect(r.got[0]?.replyQuotePart).toBe(
      '[Responde en concreto a esta parte: «el viernes cerramos»]',
    );
    const channel = await receive({
      text: 'resúmelo',
      external_reply: { origin: { type: 'channel', date: 0, chat: { title: 'Noticias' } } },
    });
    expect(channel.got[0]?.replyQuote).toBe('[Respondiendo a un mensaje de Noticias de otro chat]');
  });
});
