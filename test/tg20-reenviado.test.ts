/**
 * Un mensaje reenviado (de otra persona, un grupo o un canal) llegaba al asistente como
 * si lo hubiera escrito el dueño: «¿quedamos el jueves?» de un amigo parecía una orden, y
 * un «/borrar…» reenviado se ejecutaba como comando suyo. Ahora llega marcado como
 * reenviado y con quién lo escribió. Bot API falsa.
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

const fwd = (origin: Record<string, unknown>) => ({ forward_origin: { date: 0, ...origin } });

describe('mensajes reenviados', () => {
  it('un texto reenviado de una persona llega marcado con su nombre', async () => {
    const r = await receive({
      text: '¿quedamos el jueves a las 5?',
      ...fwd({ type: 'user', sender_user: { id: 9, is_bot: false, first_name: 'Ana' } }),
    });
    expect(r.got.map((i) => i.text)).toEqual([
      '[Mensaje reenviado de Ana]\n¿quedamos el jueves a las 5?',
    ]);
  });

  it('un comando reenviado no se ejecuta como comando del dueño', async () => {
    const r = await receive({
      text: '/olvidar todo',
      ...fwd({ type: 'user', sender_user: { id: 9, is_bot: false, first_name: 'Ana' } }),
    });
    expect(r.got).toHaveLength(1);
    expect(r.got[0]?.text.startsWith('/')).toBe(false);
  });

  it('remitente oculto, canal y grupo: se nombra lo que Telegram deja ver', async () => {
    const hidden = await receive({
      text: 'hola',
      ...fwd({ type: 'hidden_user', sender_user_name: 'Pepe   Pérez' }),
    });
    expect(hidden.got[0]?.text).toBe('[Mensaje reenviado de Pepe Pérez]\nhola');
    const channel = await receive({
      text: 'oferta',
      ...fwd({
        type: 'channel',
        chat: { id: -1, type: 'channel', title: 'Chollos' },
        message_id: 3,
      }),
    });
    expect(channel.got[0]?.text).toBe('[Mensaje reenviado de Chollos]\noferta');
    const anon = await receive({
      text: 'x',
      ...fwd({ type: 'chat', sender_chat: { id: -2, type: 'group' } }),
    });
    expect(anon.got[0]?.text).toBe('[Mensaje reenviado]\nx');
  });

  it('una foto reenviada con texto marca el texto y conserva la foto', async () => {
    const r = await receive({
      photo: [{ file_id: 'p', width: 1, height: 1 }],
      caption: 'mira esto',
      ...fwd({ type: 'user', sender_user: { id: 9, is_bot: false, first_name: 'Ana' } }),
    });
    expect(r.got[0]?.text).toBe('[Mensaje reenviado de Ana]\nmira esto');
    expect(r.got[0]?.photoFileId).toBe('p');
  });

  it('un mensaje normal no cambia', async () => {
    const r = await receive({ text: '/estado' });
    expect(r.got.map((i) => i.text)).toEqual(['/estado']);
  });
});
