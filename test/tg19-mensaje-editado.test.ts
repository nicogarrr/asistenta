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

import { EDITED_MESSAGE_NOTE, TelegramChannel } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';

const NOTE =
  'Has editado un mensaje, pero solo leo los nuevos. Si cambia lo que me pides, mándamelo otra vez.';

async function edits(
  list: Array<Record<string, unknown>>,
  opts: { from?: number; chat?: string } = {},
) {
  const got: Inbound[] = [];
  const replies: Array<{ text: string; extra: unknown }> = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  const type = opts.chat ?? 'private';
  for (const edited of list) {
    await harness.listeners.get('edited_message')?.({
      editedMessage: { message_id: 5, date: 0, edit_date: 10, chat: { id: 42, type }, ...edited },
      from: { id: opts.from ?? 7 },
      chat: { id: 42, type },
      me: { id: 1, username: 'bot' },
      reply: async (text: string, extra: unknown) => void replies.push({ text, extra }),
    });
  }
  await channel.stop?.();
  return { got, replies };
}

afterEach(() => harness.listeners.clear());

describe('mensaje editado en Telegram', () => {
  it('avisa de que la edición no se lee, citando el mensaje, y no lanza un turno', async () => {
    const { got, replies } = await edits([{ text: 'recuérdame a las 10' }]);
    expect(EDITED_MESSAGE_NOTE).toBe(NOTE);
    expect(got).toHaveLength(0);
    expect(replies.map((r) => r.text)).toEqual([NOTE]);
    expect(replies[0]?.extra).toMatchObject({ reply_to_message_id: 5 });
  });

  it('editar varias veces el mismo mensaje avisa una sola vez', async () => {
    const { replies } = await edits([{ text: 'a' }, { text: 'ab' }, { text: 'abc' }]);
    expect(replies).toHaveLength(1);
  });

  it('una ubicación en directo (que llega como edición) no avisa', async () => {
    const { replies } = await edits([{ location: { latitude: 1, longitude: 2, live_period: 60 } }]);
    expect(replies).toHaveLength(0);
  });

  it('en un grupo o de alguien no permitido, silencio', async () => {
    expect((await edits([{ text: 'x' }], { chat: 'group' })).replies).toHaveLength(0);
    expect((await edits([{ text: 'x' }], { from: 99 })).replies).toHaveLength(0);
  });
});
