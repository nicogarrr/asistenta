import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * El manejo del 429 de Telegram con el grammY REAL (sin mockear GrammyError):
 * solo se sustituye el `fetch` del cliente por una API de Telegram falsa, así que
 * el parseo de la respuesta y el GrammyError con `parameters.retry_after` son los
 * de la versión instalada. Fija el comportamiento al subir grammY.
 */
const fake = vi.hoisted(() => {
  type Reply = Record<string, unknown>;
  const state = {
    replies: [] as Reply[],
    calls: [] as Array<{ method: string; at: number }>,
  };
  const fetch = async (url: string) => {
    const method = String(url).split('/').pop() ?? '';
    state.calls.push({ method, at: Date.now() });
    const body =
      method === 'sendMessage'
        ? (state.replies.shift() ?? {
            ok: true,
            result: { message_id: 99, date: 0, chat: { id: 42, type: 'private' } },
          })
        : { ok: true, result: true };
    return { json: async () => body };
  };
  return { state, fetch };
});

vi.mock('grammy', async (importOriginal) => {
  const real = await importOriginal<typeof import('grammy')>();
  class Bot extends real.Bot {
    constructor(token: string, config?: ConstructorParameters<typeof real.Bot>[1]) {
      super(token, {
        ...config,
        client: { ...config?.client, apiRoot: 'http://telegram.fake', fetch: fake.fetch as never },
      });
    }
  }
  return { ...real, Bot };
});

import { GrammyError } from 'grammy';
import { TelegramChannel } from '../src/channels/telegram.js';

const ok = (id: number) => ({
  ok: true,
  result: { message_id: id, date: 0, chat: { id: 42, type: 'private' } },
});
const tooMany = (seconds: number) => ({
  ok: false,
  error_code: 429,
  description: `Too Many Requests: retry after ${seconds}`,
  parameters: { retry_after: seconds },
});
const sends = () => fake.state.calls.filter((call) => call.method === 'sendMessage');
const send = (channel: TelegramChannel, text: string) =>
  channel.send({ channel: 'telegram', account: 'main', chatId: '42', text });

beforeEach(() => {
  vi.useFakeTimers();
  fake.state.replies.length = 0;
  fake.state.calls.length = 0;
});
afterEach(() => vi.useRealTimers());

it('obeys retry_after exactly with the real GrammyError and then delivers', async () => {
  const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
  fake.state.replies.push(tooMany(3), ok(11));
  const start = Date.now();
  const sent = send(channel, 'hola');
  await vi.advanceTimersByTimeAsync(2_999);
  expect(sends()).toHaveLength(1);
  await vi.runAllTimersAsync();
  await expect(sent).resolves.toBe('11');
  const [first, second] = sends();
  expect(first?.at).toBe(start);
  expect(second && second.at - start).toBeGreaterThanOrEqual(3_000);
  expect(second && second.at - start).toBeLessThan(3_100);
});

it('gives up after the same 4 attempts on repeated 429s', async () => {
  const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
  fake.state.replies.push(tooMany(1), tooMany(1), tooMany(1), tooMany(1), ok(12));
  const sent = send(channel, 'hola');
  const verdict = expect(sent).rejects.toBeInstanceOf(GrammyError);
  await vi.runAllTimersAsync();
  await verdict;
  expect(sends()).toHaveLength(4);
});

it('does not retry a permanent 400', async () => {
  const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
  fake.state.replies.push({
    ok: false,
    error_code: 400,
    description: 'Bad Request: chat not found',
  });
  const sent = send(channel, 'hola');
  const verdict = expect(sent).rejects.toMatchObject({ error_code: 400 });
  await vi.runAllTimersAsync();
  await verdict;
  expect(sends()).toHaveLength(1);
});

it('retries a 500 with backoff and delivers', async () => {
  const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
  fake.state.replies.push(
    { ok: false, error_code: 500, description: 'Internal Server Error' },
    ok(13),
  );
  const start = Date.now();
  const sent = send(channel, 'hola');
  await vi.runAllTimersAsync();
  await expect(sent).resolves.toBe('13');
  const [, second] = sends();
  expect(second && second.at - start).toBeGreaterThanOrEqual(1_000);
});
