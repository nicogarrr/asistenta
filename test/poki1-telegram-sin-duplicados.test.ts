/**
 * Telegram sin mensajes repetidos (idea de POKI, reescrita): un envío que se queda sin
 * respuesta no es un envío fallido, es un envío de resultado desconocido. Antes, un
 * `sendMessage` que tardaba más de 20 s se mandaba otra vez y Nico veía la respuesta
 * dos veces. Ahora se espera la respuesta de la petición original; solo se repite lo
 * que seguro que no salió del PC. Bot API falsa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const state: { sendMessage: (...args: unknown[]) => Promise<unknown> } = {
    sendMessage: async () => ({ message_id: 1 }),
  };
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
      sendMessage: (...args: unknown[]) => state.sendMessage(...args),
    };
    on(): void {}
    catch(): void {}
    start(): Promise<void> {
      return new Promise(() => {});
    }
    async stop(): Promise<void> {}
  }
  return { state, FakeBot };
});

vi.mock('grammy', async () => {
  const real = await vi.importActual<typeof import('grammy')>('grammy');
  return { ...real, Bot: harness.FakeBot };
});

import { GrammyError, HttpError } from 'grammy';
import { backoffFor, sendMayHaveArrived, TelegramChannel } from '../src/channels/telegram.js';

const netError = (code: string, syscall?: string) =>
  new HttpError(
    "Network request for 'sendMessage' failed!",
    Object.assign(new Error(code), { code, syscall }),
  );

describe('sendMayHaveArrived', () => {
  it('un envío que agotó su espera o se cortó a medias pudo llegar', () => {
    expect(sendMayHaveArrived(new Error('sendMessage timed out'))).toBe(true);
    expect(sendMayHaveArrived(new Error('sendPhoto timed out'))).toBe(true);
    expect(sendMayHaveArrived(netError('ECONNRESET'))).toBe(true);
  });

  it('un fallo de conexión de antes de enviar no llegó', () => {
    expect(sendMayHaveArrived(netError('ECONNREFUSED'))).toBe(false);
    expect(sendMayHaveArrived(netError('ENOTFOUND'))).toBe(false);
    expect(sendMayHaveArrived(netError('ETIMEDOUT', 'connect'))).toBe(false);
  });

  it('editar, borrar o «escribiendo…» se pueden repetir sin duplicar nada', () => {
    expect(sendMayHaveArrived(new Error('editMessageText timed out'))).toBe(false);
    expect(sendMayHaveArrived(new Error('deleteMessage timed out'))).toBe(false);
    expect(sendMayHaveArrived(new Error('sendChatAction timed out'))).toBe(false);
  });

  it('si Telegram contestó, el resultado se sabe', () => {
    const err = new GrammyError(
      'Bad Gateway',
      { ok: false, error_code: 502, description: 'Bad Gateway' },
      'sendMessage',
      {},
    );
    expect(sendMayHaveArrived(err)).toBe(false);
  });
});

describe('backoffFor con envíos', () => {
  it('no reintenta un envío que quizá llegó', () => {
    expect(backoffFor(new Error('sendMessage timed out'), 0)).toBeNull();
    expect(backoffFor(netError('ECONNRESET'), 0)).toBeNull();
  });

  it('sí reintenta lo que seguro que no salió, y las ediciones', () => {
    expect(backoffFor(netError('ECONNREFUSED'), 0)).toBe(1000);
    expect(backoffFor(new Error('editMessageText timed out'), 0)).toBe(500);
  });
});

describe('TelegramChannel.send', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function open() {
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    await channel.start({ onMessage: () => {}, log: () => {} } as never);
    return channel;
  }

  it('una respuesta lenta (más de 20 s) llega una sola vez', async () => {
    vi.useFakeTimers();
    const calls: unknown[] = [];
    harness.state.sendMessage = (...args: unknown[]) => {
      calls.push(args);
      return new Promise((resolve) => setTimeout(() => resolve({ message_id: 55 }), 25_000));
    };
    const channel = await open();
    const sent = channel.send({ chatId: '42', text: 'hola' } as never);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(sent).resolves.toBe('55');
    expect(calls).toHaveLength(1);
  });

  it('un envío cortado a medias no se repite', async () => {
    vi.useFakeTimers();
    let calls = 0;
    harness.state.sendMessage = async () => {
      calls += 1;
      throw netError('ECONNRESET');
    };
    const channel = await open();
    const sent = channel.send({ chatId: '42', text: 'hola' } as never);
    const caught = sent.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await caught).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  it('un envío que no salió del PC se reintenta y llega', async () => {
    vi.useFakeTimers();
    let calls = 0;
    harness.state.sendMessage = async () => {
      calls += 1;
      if (calls === 1) throw netError('ECONNREFUSED');
      return { message_id: 9 };
    };
    const channel = await open();
    const sent = channel.send({ chatId: '42', text: 'hola' } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(sent).resolves.toBe('9');
    expect(calls).toBe(2);
  });
});
