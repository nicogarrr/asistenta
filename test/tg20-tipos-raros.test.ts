/**
 * Tipos raros que seguían sin respuesta: un juego, una factura, contenido de pago o
 * una lista de tareas de Telegram. Bot API falsa.
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

describe('tipos raros de mensaje: aviso en vez de silencio', () => {
  it('un juego avisa y no llega al asistente', async () => {
    const r = await receive({ game: { title: 'Lumberjack', description: 'x', photo: [] } });
    expect(r.got).toHaveLength(0);
    expect(r.replies).toEqual([
      'Aún no sé jugar a juegos de Telegram. Si quieres algo, escríbemelo.',
    ]);
  });

  it('una factura avisa y deja claro que no se paga nada', async () => {
    const r = await receive({
      invoice: {
        title: 'T',
        description: 'd',
        start_parameter: 's',
        currency: 'EUR',
        total_amount: 100,
      },
    });
    expect(r.got).toHaveLength(0);
    expect(r.replies).toEqual([
      'Aún no sé leer facturas de Telegram y no pago nada desde aquí. Escríbeme qué necesitas.',
    ]);
  });

  it('contenido de pago sin texto avisa', async () => {
    const r = await receive({ paid_media: { star_count: 5, paid_media: [{ type: 'preview' }] } });
    expect(r.got).toHaveLength(0);
    expect(r.replies).toEqual([
      'Aún no puedo ver contenido de pago. Cuéntame qué hay o mándame una captura.',
    ]);
  });

  it('contenido de pago con texto: el texto llega y avisa de que lo de pago no se ve', async () => {
    const r = await receive({
      paid_media: { star_count: 5, paid_media: [{ type: 'preview' }] },
      caption: '¿qué te parece?',
    });
    expect(r.got.map((i) => i.text)).toEqual(['¿qué te parece?']);
    expect(r.replies).toEqual(['Aún no puedo ver contenido de pago: te contesto solo al texto.']);
  });

  it('una lista de tareas de Telegram avisa', async () => {
    const r = await receive({ checklist: { title: 'Compra', tasks: [{ id: 1, text: 'pan' }] } });
    expect(r.got).toHaveLength(0);
    expect(r.replies).toEqual([
      'Aún no sé leer listas de tareas de Telegram. Escríbemelas como texto.',
    ]);
  });
});
