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

const LINK = 'https://www.google.com/maps?q=40.416775,-3.70379';

describe('una ubicación compartida llega al asistente como texto', () => {
  it('ubicación suelta: coordenadas y enlace de mapa, sin el aviso de antes', async () => {
    const { got, replies } = await receive({
      location: { latitude: 40.416775, longitude: -3.70379 },
    });
    expect(replies).toEqual([]);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe(`[Ubicación compartida: 40.416775, -3.70379 — ${LINK}]`);
  });

  it('un sitio (venue) trae nombre y dirección', async () => {
    const { got } = await receive({
      location: { latitude: 40.4138, longitude: -3.6921 },
      venue: {
        location: { latitude: 40.4138, longitude: -3.6921 },
        title: 'Museo del Prado',
        address: 'Calle de Ruiz de Alarcón, 23, Madrid',
      },
    });
    expect(got[0]?.text).toBe(
      '[Sitio compartido: «Museo del Prado», Calle de Ruiz de Alarcón, 23, Madrid — 40.4138, -3.6921 — https://www.google.com/maps?q=40.4138,-3.6921]',
    );
  });

  it('ubicación en directo dice que solo se ve el punto de partida', async () => {
    const { got } = await receive({
      location: { latitude: 40.416775, longitude: -3.70379, live_period: 900 },
    });
    expect(got[0]?.text).toContain('(en directo; la sigo para los avisos al llegar)');
    expect(got[0]?.text).toContain(LINK);
  });

  it('nunca se toma por comando y una ubicación reenviada lleva su marca', async () => {
    const { got } = await receive({
      location: { latitude: 40.416775, longitude: -3.70379 },
      forward_origin: { type: 'user', sender_user: { first_name: 'Ana' } },
    });
    expect(got[0]?.text.startsWith('[')).toBe(true);
    expect(got[0]?.text).toBe(
      `[Mensaje reenviado de Ana]\n[Ubicación compartida: 40.416775, -3.70379 — ${LINK}]`,
    );
  });

  it('responder a una ubicación cita el sitio', async () => {
    const { got } = await receive({
      text: '¿qué hay cerca?',
      reply_to_message: {
        message_id: 3,
        date: 0,
        chat: { id: 42, type: 'private' },
        from: { id: 7, first_name: 'Nico' },
        location: { latitude: 40.416775, longitude: -3.70379 },
      },
    });
    expect(got[0]?.replyQuote).toContain(LINK);
  });

  it('coordenadas imposibles no inventan un sitio', async () => {
    const { got } = await receive({ location: { latitude: 140, longitude: -3.7 } });
    expect(got).toHaveLength(0);
  });
});
