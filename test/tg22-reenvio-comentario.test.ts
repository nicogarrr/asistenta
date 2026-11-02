/**
 * Un texto reenviado largo (≥3.500 caracteres) espera un momento a su continuación, por
 * si Telegram lo partió. Si justo detrás escribías tu comentario («resúmelo»), se unía al
 * reenvío y quedaba bajo la marca «[Mensaje reenviado de Ana]», como si lo hubiera escrito
 * Ana. Ahora sigue en el mismo turno pero separado: lo que sigue a la marca de cierre es
 * tuyo. Bot API falsa, relojes falsos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { FORWARDED_END, TelegramChannel } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';

async function open() {
  const chat = { id: 42, type: 'private' };
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  let id = 10;
  const send = async (message: Record<string, unknown>) => {
    id += 1;
    await harness.listeners.get('message')?.({
      message: { message_id: id, date: 0, chat, ...message },
      from: { id: 7 },
      chat,
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
  };
  return { got, send };
}

const ana = {
  forward_origin: { type: 'user', date: 0, sender_user: { id: 9, first_name: 'Ana' } },
};
const long = 'x'.repeat(3600);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('reenvío largo y tu comentario', () => {
  it('tu comentario va en el mismo turno, pero fuera de la marca del reenvío', async () => {
    const { got, send } = await open();
    await send({ text: long, ...ana });
    await send({ text: 'resúmelo' });
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(`[Mensaje reenviado de Ana]\n${long}\n${FORWARDED_END}\nresúmelo`);
  });

  it('la continuación del mismo reenvío se une sin repetir la marca', async () => {
    const { got, send } = await open();
    await send({ text: long, ...ana });
    await send({ text: 'y fin', ...ana });
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(`[Mensaje reenviado de Ana]\n${long}\ny fin`);
  });

  it('un reenvío detrás de tu texto largo no se mete en tu texto', async () => {
    const { got, send } = await open();
    await send({ text: long });
    await send({ text: 'hola', ...ana });
    expect(got.map((i) => i.text)).toEqual([long, '[Mensaje reenviado de Ana]\nhola']);
    expect(got[1]?.forwardedFrom).toBe('[Mensaje reenviado de Ana]');
  });

  it('tu texto largo partido se sigue uniendo como siempre', async () => {
    const { got, send } = await open();
    await send({ text: long });
    await send({ text: 'resto' });
    expect(got.map((i) => i.text)).toEqual([`${long}\nresto`]);
  });
});
