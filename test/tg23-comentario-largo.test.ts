/**
 * Un reenvío largo y tu comentario justo detrás van en un turno, con tu comentario fuera
 * de la marca del reenvío. Pero si tu comentario también era largo (≥3.500 caracteres),
 * salía en el acto, sin esperar a su continuación: Telegram lo parte y el resto llegaba
 * como otro turno, contestado a medias. Ahora tu comentario largo también espera a su
 * continuación, y esta se une a tu parte (sin repetir la marca de cierre). Bot API
 * falsa, relojes falsos.
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

const mine = 'y'.repeat(3600);

describe('reenvío largo y tu comentario también largo', () => {
  it('tu comentario largo espera a su continuación y va todo en un turno', async () => {
    const { got, send } = await open();
    await send({ text: long, ...ana });
    await send({ text: mine });
    expect(got).toHaveLength(0);
    await send({ text: 'y resúmelo' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(
      `[Mensaje reenviado de Ana]\n${long}\n${FORWARDED_END}\n${mine}\ny resúmelo`,
    );
  });

  it('sin continuación, tu comentario largo sale solo tras la espera', async () => {
    const { got, send } = await open();
    await send({ text: long, ...ana });
    await send({ text: mine });
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(`[Mensaje reenviado de Ana]\n${long}\n${FORWARDED_END}\n${mine}`);
  });

  it('otro reenvío detrás de tu comentario no se mete en tu parte', async () => {
    const { got, send } = await open();
    await send({ text: long, ...ana });
    await send({ text: mine });
    await send({ text: 'otra cosa', ...ana });
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.text)).toEqual([
      `[Mensaje reenviado de Ana]\n${long}\n${FORWARDED_END}\n${mine}`,
      '[Mensaje reenviado de Ana]\notra cosa',
    ]);
  });
});
