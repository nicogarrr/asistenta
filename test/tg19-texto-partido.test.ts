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

const long = (c: string) => `${c.repeat(3990)} fin`;

async function open() {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  let id = 10;
  const send = async (message: Record<string, unknown>) => {
    id += 1;
    await harness.listeners.get('message')?.({
      message: { message_id: id, date: 0, chat: { id: 42, type: 'private' }, ...message },
      from: { id: 7 },
      chat: { id: 42, type: 'private' },
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
  };
  return { got, send, channel };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('texto largo que Telegram parte en varios mensajes', () => {
  it('las dos partes llegan juntas en un solo mensaje', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await send({ text: 'y esta es la segunda parte' });
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(`${long('a')}\ny esta es la segunda parte`);
    expect(got[0]?.messageId).toBe('11');
  });

  it('tres partes (dos largas y una corta) también llegan juntas', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await send({ text: long('b') });
    expect(got).toHaveLength(0);
    await send({ text: 'cola' });
    expect(got.map((i) => i.text)).toEqual([`${long('a')}\n${long('b')}\ncola`]);
  });

  it('un texto largo solo se entrega al poco aunque no llegue nada más', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.text)).toEqual([long('a')]);
  });

  it('un mensaje normal no espera nada', async () => {
    const { got, send } = await open();
    await send({ text: 'hola' });
    expect(got.map((i) => i.text)).toEqual(['hola']);
  });

  it('una foto después de un texto largo no se mezcla y respeta el orden', async () => {
    const { got, send } = await open();
    await send({ text: long('a') });
    await send({ photo: [{ file_id: 'p', width: 1, height: 1 }] });
    expect(got.map((i) => i.text)).toEqual([long('a'), '']);
    expect(got[1]?.photoFileId).toBe('p');
  });

  it('al parar el canal, el texto retenido se entrega', async () => {
    const { got, send, channel } = await open();
    await send({ text: long('a') });
    await channel.stop?.();
    expect(got).toHaveLength(1);
  });
});
