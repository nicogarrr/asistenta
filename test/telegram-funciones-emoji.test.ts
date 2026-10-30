import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const edits: string[] = [];
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      editMessageText: async (_c: number, _m: number, text: string) => {
        edits.push(text);
        return true;
      },
      sendMessage: async (_c: number, text: string) => {
        edits.push(text);
        return { message_id: 1 };
      },
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
  return { listeners, edits, FakeBot, Plain };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.Plain,
  HttpError: harness.Plain,
  InlineKeyboard: harness.Plain,
  InputFile: harness.Plain,
}));

import { clipTelegramText, TelegramChannel } from '../src/channels/telegram.js';

const loneHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

afterEach(() => {
  harness.listeners.clear();
  harness.edits.length = 0;
});

describe('botón de /funciones con texto largo', () => {
  it('no parte un emoji al cortar a 4000 caracteres', async () => {
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    const text = `${'a'.repeat(3999)}😀 y más`;
    await channel.start({
      onMessage: () => {},
      log: () => {},
      onFuncionesButton: async () => ({ text, buttons: [] }),
    } as never);
    await harness.listeners.get('callback_query:data')?.({
      callbackQuery: {
        data: 'fn:x',
        message: { chat: { id: 42, type: 'private' }, message_id: 9 },
      },
      from: { id: 7 },
      answerCallbackQuery: async () => true,
    });
    await channel.stop?.();
    expect(harness.edits).toHaveLength(1);
    expect(harness.edits[0]).not.toMatch(loneHalf);
    expect(harness.edits[0]?.length).toBeLessThanOrEqual(4000);
  });

  it('clipTelegramText deja el texto corto igual y corta antes del emoji', () => {
    expect(clipTelegramText('hola')).toBe('hola');
    expect(clipTelegramText(`ab😀`, 3)).toBe('ab');
    expect(clipTelegramText(`ab😀c`, 4)).toBe('ab😀');
  });
});
