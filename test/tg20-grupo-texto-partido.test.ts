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

import { TelegramChannel } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';

const long = (c: string) => `@bot ${c.repeat(3990)} fin`;

async function open() {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7, 8] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  let id = 10;
  const send = async (message: Record<string, unknown>, from = 7) => {
    id += 1;
    const chat = { id: -42, type: 'supergroup' };
    await harness.listeners.get('message')?.({
      message: { message_id: id, date: 0, chat, ...message },
      from: { id: from },
      chat,
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
  };
  return { got, send };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

// En un grupo, Telegram parte un texto largo y solo el primer trozo lleva «@bot».
describe('grupo: texto largo partido por Telegram', () => {
  it('la continuación sin mención se une al texto retenido del mismo usuario', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await send({ text: 'y esta es la segunda parte' });
    expect(got.map((i) => i.text)).toEqual([`${long('a')}\ny esta es la segunda parte`]);
  });

  it('el mensaje sin mención de OTRO usuario no se une ni se atiende', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await send({ text: 'yo también quiero algo' }, 8);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.text)).toEqual([long('a')]);
  });

  it('sin texto retenido, un mensaje sin mención se sigue ignorando', async () => {
    const { got, send } = await open();
    await send({ text: 'hola a todos' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(0);
  });

  it('pasada la espera, un mensaje sin mención ya no se une', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await vi.advanceTimersByTimeAsync(2000);
    await send({ text: 'otra cosa' });
    expect(got.map((i) => i.text)).toEqual([long('a')]);
  });

  it('una foto o un comando sin mención no cuentan como continuación', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await send({ photo: [{ file_id: 'p', width: 1, height: 1 }] });
    await send({ text: '/estado' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.text)).toEqual([long('a')]);
  });
});
