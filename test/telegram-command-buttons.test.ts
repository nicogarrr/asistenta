/**
 * Botones que equivalen a teclear una orden («🗑 Dejar de vigilar …» en /vigilando),
 * contra el gramY de mentira de las pruebas de botones (sin token ni red).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_CALLBACK_PREFIX,
  commandButton,
  commandFromCallback,
  STALE_BUTTON,
  TelegramChannel,
} from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';
import { watchStopButtons } from '../src/cli.js';

const harness = vi.hoisted(() => {
  const sent: Array<{
    chatId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const edits: Array<{
    chatId: number;
    messageId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const answers: string[] = [];
  const markups: Array<{ chatId: number; messageId: number; rows: number }> = [];
  const handlers = new Map<string, (ctx: unknown) => unknown>();

  /** Mirrors gramY's InlineKeyboard: one row by default, text() fills the last row. */
  class FakeInlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [[]];
    row(): FakeInlineKeyboard {
      this.inline_keyboard.push([]);
      return this;
    }
    text(label: string, callbackData: string): FakeInlineKeyboard {
      this.inline_keyboard[this.inline_keyboard.length - 1]?.push({
        text: label,
        callback_data: callbackData,
      });
      return this;
    }
  }

  class FakeInputFile {
    readonly data: unknown;
    constructor(data: unknown) {
      this.data = data;
    }
  }

  class FakeGrammyError extends Error {
    readonly error_code: number;
    readonly description: string;
    constructor(errorCode: number, description: string) {
      super(description);
      this.error_code = errorCode;
      this.description = description;
    }
  }

  class FakeHttpError extends Error {}

  class FakeBot {
    readonly api = {
      // The channel installs its polling-health transformer here (grammy API).
      config: {
        use: () => ({}),
      },
      sendMessage: async (
        chatId: number,
        text: string,
        other?: { reply_markup?: FakeInlineKeyboard },
      ) => {
        sent.push({
          chatId,
          text,
          keyboard: other?.reply_markup ? other.reply_markup.inline_keyboard : [],
        });
        return { message_id: sent.length };
      },
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        other?: {
          reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
        },
      ) => {
        edits.push({
          chatId,
          messageId,
          text,
          keyboard: other?.reply_markup?.inline_keyboard ?? [],
        });
        return true;
      },
      editMessageReplyMarkup: async (
        chatId: number,
        messageId: number,
        other?: { reply_markup?: { inline_keyboard: unknown[] } },
      ) => {
        markups.push({
          chatId,
          messageId,
          rows: other?.reply_markup?.inline_keyboard.length ?? -1,
        });
        return true;
      },
      setMyCommands: async () => true,
    };

    on(event: string, fn: (ctx: unknown) => unknown): void {
      handlers.set(event, fn);
    }

    catch(_handler: (err: unknown) => void): void {}

    async start(opts?: {
      onStart?: (me: { id: number; username: string }) => void;
    }): Promise<void> {
      opts?.onStart?.({ id: 1, username: 'asistenta_test_bot' });
    }

    async stop(): Promise<void> {}
  }

  return {
    sent,
    edits,
    answers,
    markups,
    handlers,
    FakeBot,
    FakeInlineKeyboard,
    FakeInputFile,
    FakeGrammyError,
    FakeHttpError,
  };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeGrammyError,
  HttpError: harness.FakeHttpError,
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: harness.FakeInputFile,
}));

beforeEach(() => {
  harness.sent.length = 0;
  harness.edits.length = 0;
  harness.answers.length = 0;
  harness.markups.length = 0;
});

let nextMessageId = 900;
const received: Inbound[] = [];

async function makeChannel(): Promise<TelegramChannel> {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7],
    approvalTtlMs: 60_000,
  });
  await channel.start({
    onMessage: (inbound) => {
      received.push(inbound);
    },
    log: () => {},
  });
  return channel;
}

async function press(data: string, chatId = 42, userId = 7, type = 'private'): Promise<void> {
  const handler = harness.handlers.get('callback_query:data');
  if (!handler) throw new Error('the adapter did not register a callback handler');
  await handler({
    callbackQuery: { data, message: { chat: { id: chatId, type }, message_id: nextMessageId++ } },
    from: { id: userId, first_name: 'Nico' },
    answerCallbackQuery: async (args?: { text?: string }) => {
      harness.answers.push(args?.text ?? '');
      return true;
    },
  });
}

beforeEach(() => {
  received.length = 0;
});

describe('commandButton / commandFromCallback', () => {
  it('un botón de /dejar_de_vigilar se lee como la orden tecleada', () => {
    const b = commandButton('🗑 Dejar de vigilar PS5', 'dejar_de_vigilar', 'w1a2');
    expect(b).toEqual({ label: '🗑 Dejar de vigilar PS5', action: 'cmd:dejar_de_vigilar w1a2' });
    expect(commandFromCallback(b?.action ?? '')).toBe('/dejar_de_vigilar w1a2');
  });

  it('solo órdenes de la lista y solo ids simples', () => {
    expect(commandButton('x', 'olvida_todo', 'a')).toBeUndefined();
    expect(commandButton('x', 'dejar_de_vigilar', 'a b')).toBeUndefined();
    expect(commandButton('x', 'dejar_de_vigilar', 'a'.repeat(41))).toBeUndefined();
    expect(commandFromCallback(`${COMMAND_CALLBACK_PREFIX}olvida_todo a`)).toBeUndefined();
    expect(commandFromCallback(`${COMMAND_CALLBACK_PREFIX}dejar_de_vigilar a;b`)).toBeUndefined();
    expect(commandFromCallback(`${COMMAND_CALLBACK_PREFIX}dejar_de_vigilar`)).toBeUndefined();
    expect(commandFromCallback('approve:abc')).toBeUndefined();
  });

  it('las etiquetas largas se recortan para que quepan en el móvil', () => {
    const b = commandButton(`🗑 Dejar de vigilar ${'x'.repeat(60)}`, 'dejar_de_vigilar', 'a');
    expect(b?.label.length).toBeLessThanOrEqual(40);
    expect(b?.label.endsWith('…')).toBe(true);
  });
});

describe('pulsar un botón de orden', () => {
  it('entra como la orden escrita por quien pulsa, en ese chat', async () => {
    await makeChannel();
    await press('cmd:dejar_de_vigilar w1a2');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      channel: 'telegram',
      chatId: '42',
      userId: '7',
      text: '/dejar_de_vigilar w1a2',
      authorised: true,
      isGroup: false,
    });
    expect(harness.answers).toEqual(['']);
  });

  it('en un grupo se marca como grupo', async () => {
    await makeChannel();
    await press('cmd:dejar_de_vigilar w1a2', -100, 7, 'supergroup');
    expect(received[0]).toMatchObject({ chatId: '-100', isGroup: true });
  });

  it('alguien no permitido no lanza nada', async () => {
    await makeChannel();
    await press('cmd:dejar_de_vigilar w1a2', 42, 99);
    expect(received).toHaveLength(0);
  });

  it('una orden fuera de la lista no se lanza y avisa en español', async () => {
    await makeChannel();
    await press('cmd:olvida_todo x');
    expect(received).toHaveLength(0);
    expect(harness.answers).toEqual([STALE_BUTTON]);
  });
});

describe('/vigilando trae un botón por página', () => {
  it('uno por página, con su nombre o su enlace', () => {
    const buttons = watchStopButtons([
      { id: 'a1', label: 'PS5', url: 'https://tienda.example/ps5' },
      { id: 'b2', label: '', url: 'https://tienda.example/tv' },
    ]);
    expect(buttons?.[0]).toEqual({
      label: '🗑 Dejar de vigilar PS5',
      action: 'cmd:dejar_de_vigilar a1',
    });
    expect(buttons?.[1]?.action).toBe('cmd:dejar_de_vigilar b2');
    expect(buttons?.[1]?.label.startsWith('🗑 Dejar de vigilar https://tienda')).toBe(true);
    expect(buttons?.[1]?.label.length).toBeLessThanOrEqual(40);
  });

  it('sin páginas no hay botones, y como mucho 8', () => {
    expect(watchStopButtons([])).toBeUndefined();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, label: `P${i}`, url: 'u' }));
    expect(watchStopButtons(many)).toHaveLength(8);
  });
});
