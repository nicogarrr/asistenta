import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  class GrammyError extends Error {
    readonly error_code = 429;
    readonly description = 'Too Many Requests';
    readonly parameters: { retry_after: number };
    constructor(seconds: number) {
      super('Too Many Requests');
      this.parameters = { retry_after: seconds };
    }
  }
  const state = { calls: [] as Array<{ chatId: number; at: number }>, retryAfter: 0 };
  class Bot {
    readonly api = {
      sendMessage: async (chatId: number) => {
        state.calls.push({ chatId, at: Date.now() });
        if (state.retryAfter) {
          const seconds = state.retryAfter;
          state.retryAfter = 0;
          throw new GrammyError(seconds);
        }
        return { message_id: state.calls.length };
      },
    };
  }
  return { state, Bot, GrammyError };
});

vi.mock('grammy', () => ({
  Bot: harness.Bot,
  GrammyError: harness.GrammyError,
  HttpError: class extends Error {},
  InlineKeyboard: class {},
  InputFile: class {},
}));

import { TelegramChannel } from '../src/channels/telegram.js';

beforeEach(() => {
  vi.useFakeTimers();
  harness.state.calls.length = 0;
  harness.state.retryAfter = 0;
});
afterEach(() => vi.useRealTimers());

it('shares a 429 cooldown with concurrent sends to other chats', async () => {
  const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
  const start = Date.now();
  harness.state.retryAfter = 7;
  const first = channel.send({ channel: 'telegram', account: 'main', chatId: '42', text: 'first' });
  const second = channel.send({
    channel: 'telegram',
    account: 'main',
    chatId: '43',
    text: 'second',
  });
  await vi.advanceTimersByTimeAsync(6_999);
  expect(harness.state.calls).toEqual([{ chatId: 42, at: start }]);
  await vi.runAllTimersAsync();
  await Promise.all([first, second]);
  expect(harness.state.calls).toHaveLength(3);
  expect(harness.state.calls.slice(1).every((call) => call.at >= start + 7_000)).toBe(true);
  const [one, two] = harness.state.calls.slice(1);
  expect(one && two && two.at - one.at).toBeGreaterThanOrEqual(1_100);
});

it('fails fast rather than holding the global gate beyond the retry budget', async () => {
  const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
  harness.state.retryAfter = 120;
  await expect(
    channel.send({ channel: 'telegram', account: 'main', chatId: '42', text: 'first' }),
  ).rejects.toBeInstanceOf(harness.GrammyError);
  await expect(
    channel.send({ channel: 'telegram', account: 'main', chatId: '43', text: 'second' }),
  ).rejects.toBeInstanceOf(harness.GrammyError);
  expect(harness.state.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(
    channel.send({ channel: 'telegram', account: 'main', chatId: '43', text: 'later' }),
  ).resolves.toBe('2');
});
