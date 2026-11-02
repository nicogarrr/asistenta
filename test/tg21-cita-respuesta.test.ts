/**
 * Una respuesta a un mensaje que la conversación no tiene (de antes de un reinicio, de otra
 * persona en un grupo, un reenvío viejo) solo pasaba el id: «¿qué significa esto?» no sabía
 * a qué se refería. Ahora el texto respondido llega marcado como cita, y solo cuando ese
 * mensaje no está ya en la conversación. El texto del dueño (comandos, «sí») no cambia.
 * Bot API falsa.
 */
import { readFileSync } from 'node:fs';
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
const reply = (extra: Record<string, unknown>) => ({
  reply_to_message: { message_id: 3, date: 0, chat: { id: 42, type: 'private' }, ...extra },
});

describe('respuesta a un mensaje: cita marcada', () => {
  it('la respuesta lleva el texto citado, con quién lo escribió, sin tocar el texto del dueño', async () => {
    const r = await receive({
      text: '¿qué significa esto?',
      ...reply({ from: ana, text: 'nos vemos en el TPV' }),
    });
    expect(r.got[0]?.text).toBe('¿qué significa esto?');
    expect(r.got[0]?.replyToMessageId).toBe('3');
    expect(r.got[0]?.replyQuote).toBe('[Respondiendo a un mensaje de Ana: «nos vemos en el TPV»]');
  });

  it('a un mensaje del propio bot, a un reenvío y a una foto con pie', async () => {
    const bot = await receive({
      text: 'y eso?',
      ...reply({ from: { id: 1, is_bot: true, first_name: 'Bot' }, text: 'Hecho.' }),
    });
    expect(bot.got[0]?.replyQuote).toBe('[Respondiendo a tu mensaje: «Hecho.»]');
    const fwd = await receive({
      text: 'resúmelo',
      ...reply({
        from: { id: 7, is_bot: false, first_name: 'Nico' },
        forward_origin: { type: 'user', date: 0, sender_user: ana },
        text: 'mañana no puedo',
      }),
    });
    expect(fwd.got[0]?.replyQuote).toBe(
      '[Respondiendo a un mensaje reenviado de Ana: «mañana no puedo»]',
    );
    const photo = await receive({
      text: '¿dónde es?',
      ...reply({ from: ana, caption: 'la playa\nde ayer', photo: [] }),
    });
    expect(photo.got[0]?.replyQuote).toBe('[Respondiendo a un mensaje de Ana: «la playa de ayer»]');
  });

  it('un mensaje respondido sin texto no añade nada; uno largo se corta sin partir emojis', async () => {
    const none = await receive({ text: 'mira', ...reply({ from: ana, sticker: {} }) });
    expect(none.got[0]?.replyQuote).toBeUndefined();
    const long = await receive({
      text: 'ok',
      ...reply({ from: ana, text: `${'a'.repeat(299)}😀 resto` }),
    });
    expect(long.got[0]?.replyQuote).toBe(
      `[Respondiendo a un mensaje de Ana: «${'a'.repeat(299)}…»]`,
    );
  });

  it('un mensaje sin respuesta no lleva cita', async () => {
    const r = await receive({ text: 'hola' });
    expect(r.got[0]?.replyQuote).toBeUndefined();
  });

  it('la cita va delante solo si el mensaje respondido no está en la conversación', () => {
    const q = '[Respondiendo a un mensaje de Ana: «hola»]';
    expect(withReplyQuote('¿qué significa?', q, false)).toBe(`${q}\n¿qué significa?`);
    expect(withReplyQuote('¿qué significa?', q, true)).toBe('¿qué significa?');
    expect(withReplyQuote('¿qué significa?', undefined, false)).toBe('¿qué significa?');
  });

  it('el turno decide «en la conversación» por el hilo del mensaje respondido', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain('inbound.replyQuote,\n');
    expect(src).toContain('inbound.replyToMessageId}`) === thread.key,');
  });
});
