import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const calls: Array<{ method: string; options?: Record<string, unknown> }> = [];
  class GrammyError extends Error {
    readonly error_code = 400;
    readonly description = 'Bad Request: message text is empty';
  }
  class Bot {
    readonly api = {
      sendMessage: async (_chatId: number, text: string, options?: Record<string, unknown>) => {
        calls.push({ method: 'sendMessage', options });
        if (!text.trim()) throw new GrammyError();
        return { message_id: 1 };
      },
      sendPhoto: async (_chatId: number, _file: unknown, options?: Record<string, unknown>) => {
        calls.push({ method: 'sendPhoto', options });
        return { message_id: 2 };
      },
      sendDocument: async (_chatId: number, _file: unknown, options?: Record<string, unknown>) => {
        calls.push({ method: 'sendDocument', options });
        return { message_id: 3 };
      },
      sendVoice: async (_chatId: number, _file: unknown, options?: Record<string, unknown>) => {
        calls.push({ method: 'sendVoice', options });
        return { message_id: 4 };
      },
    };
  }
  return { calls, Bot, GrammyError };
});

vi.mock('grammy', () => ({
  Bot: harness.Bot,
  GrammyError: harness.GrammyError,
  HttpError: class extends Error {},
  InlineKeyboard: class {},
  InputFile: class {},
}));

import { TelegramChannel } from '../src/channels/telegram.js';

const outbound = { channel: 'telegram', account: 'main', chatId: '42', threadId: '7', text: '' };
const audio = { mimeType: 'audio/mpeg', data: Buffer.from('voice').toString('base64') };
const image = {
  type: 'image' as const,
  mimeType: 'image/png',
  data: Buffer.from('image').toString('base64'),
};

beforeEach(() => {
  harness.calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function channel(): TelegramChannel {
  return new TelegramChannel({ token: 'test', allowedUserIds: [7] });
}

describe('attachment-only Telegram replies', () => {
  it('sends a photo without an empty text request and returns its message id', async () => {
    await expect(channel().send({ ...outbound, images: [image] })).resolves.toBe('2');
    expect(harness.calls).toEqual([{ method: 'sendPhoto', options: { message_thread_id: 7 } }]);
  });

  it('sends voice without an empty text request and returns its message id', async () => {
    await expect(channel().send({ ...outbound, audio })).resolves.toBe('4');
    expect(harness.calls.map((call) => call.method)).toEqual(['sendVoice']);
    expect(harness.calls[0]?.options?.message_thread_id).toBe(7);
  });

  it('ignores whitespace-only text and an entirely empty outbound', async () => {
    await expect(channel().send({ ...outbound, text: ' \n\t ' })).resolves.toBeNull();
    expect(harness.calls).toEqual([]);
  });

  it('keeps text first and preserves its id when both attachments follow', async () => {
    const result = channel().send({ ...outbound, text: 'Respuesta', images: [image], audio });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('1');
    expect(harness.calls.map((call) => call.method)).toEqual([
      'sendMessage',
      'sendPhoto',
      'sendVoice',
    ]);
  });

  it('supports the text-and-voice entry point with an empty transcript', async () => {
    await expect(channel().sendTextAndVoice(outbound, audio)).resolves.toBe('4');
    expect(harness.calls.map((call) => call.method)).toEqual(['sendVoice']);
  });
});

describe('Telegram photo geometry', () => {
  it.each([
    { width: 21, height: 500 },
    { width: 500, height: 21 },
    { width: 1280, height: 11000 },
  ])('sends an unsupported $width x $height image as a document', async (size) => {
    await expect(channel().sendPhotoBytes(42, Buffer.from('image'), '7', size)).resolves.toBe('3');
    expect(harness.calls).toEqual([{ method: 'sendDocument', options: { message_thread_id: 7 } }]);
  });

  it.each([
    { width: 25, height: 500 },
    { width: 500, height: 25 },
    { width: 1280, height: 720 },
  ])('keeps supported $width x $height images as photos', async (size) => {
    await expect(channel().sendPhotoBytes(42, Buffer.from('image'), '7', size)).resolves.toBe('2');
    expect(harness.calls.map((call) => call.method)).toEqual(['sendPhoto']);
  });
});
