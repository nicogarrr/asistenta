/**
 * «📖 Ver todo» bajo una respuesta recortada, contra el mismo gramY de mentira que
 * las pruebas de aprobación (sin token ni red).
 *
 * The stand-in exists only to capture what the adapter would send and to feed
 * button presses back in. The Bot constructor and long polling are never reached,
 * so no token and no network are involved: the resolution logic is what is under
 * test, not Telegram.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApprovalChoice,
  cacheFullReply,
  MORE_BUTTON_LABEL,
  moreButton,
  TelegramChannel,
  takeFullReply,
} from '../src/channels/telegram.js';

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

let nextMessageId = 500;

async function makeChannel(): Promise<TelegramChannel> {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7],
    approvalTtlMs: 60_000,
  });
  await channel.start({ onMessage: () => {}, log: () => {} });
  return channel;
}

async function press(data: string, chatId = 42, userId = 7): Promise<number> {
  const handler = harness.handlers.get('callback_query:data');
  if (!handler) throw new Error('the adapter did not register a callback handler');
  const messageId = nextMessageId++;
  await handler({
    callbackQuery: { data, message: { chat: { id: chatId }, message_id: messageId } },
    from: { id: userId },
    answerCallbackQuery: async (args?: { text?: string }) => {
      harness.answers.push(args?.text ?? '');
      return true;
    },
  });
  return messageId;
}

async function stateOf(pending: Promise<ApprovalChoice>): Promise<'settled' | 'pending'> {
  return Promise.race([
    pending.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), 50);
    }),
  ]);
}

const FULL = 'Primera parte.\n\n## Detalle\n\n**Punto clave** con todo el texto que no cabía.';

describe('botón «📖 Ver todo»', () => {
  it('la respuesta recortada lleva el botón y pulsarlo manda el texto completo una sola vez', async () => {
    const channel = await makeChannel();
    cacheFullReply('hilo-a', FULL);
    const button = moreButton('hilo-a', '42');
    expect(button.label).toBe(MORE_BUTTON_LABEL);
    expect(Buffer.byteLength(button.action)).toBeLessThanOrEqual(64);
    await channel.send({
      channel: 'telegram',
      account: channel.account,
      chatId: '42',
      text: 'Primera parte…',
      buttons: [button],
    });
    expect(harness.sent[0]?.keyboard.flat().map((b) => b.text)).toEqual([MORE_BUTTON_LABEL]);

    const pressedOn = await press(button.action);
    // Se quita el botón del mensaje recortado.
    expect(harness.markups).toEqual([{ chatId: 42, messageId: pressedOn, rows: 0 }]);
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]?.chatId).toBe(42);
    expect(harness.sent[1]?.text).toContain('Punto clave');
    expect(harness.sent[1]?.text).toContain('todo el texto que no cabía');
    expect(harness.sent[1]?.text).not.toContain('##');
    // Consumido: «más» ya no repite el mismo texto.
    expect(takeFullReply('hilo-a')).toBeNull();

    // Segunda pulsación: aviso y nada más.
    await press(button.action);
    expect(harness.sent).toHaveLength(2);
    expect(harness.answers.at(-1)).toMatch(/Ya no tengo el texto completo/);
  });

  it('si ya se pidió con «más» (o caducó), avisa y no envía nada', async () => {
    await makeChannel();
    cacheFullReply('hilo-b', FULL);
    const button = moreButton('hilo-b', '42');
    expect(takeFullReply('hilo-b')).toBe(FULL);
    await press(button.action);
    expect(harness.sent).toHaveLength(0);
    expect(harness.answers.at(-1)).toMatch(/Ya no tengo el texto completo/);
    expect(harness.markups).toHaveLength(1);
  });

  it('pulsado desde otro chat no entrega el texto', async () => {
    await makeChannel();
    cacheFullReply('hilo-c', FULL);
    const button = moreButton('hilo-c', '42');
    await press(button.action, 99);
    expect(harness.sent).toHaveLength(0);
    expect(harness.answers.at(-1)).toMatch(/Ya no tengo el texto completo/);
  });

  it('un usuario no permitido no lo usa', async () => {
    await makeChannel();
    cacheFullReply('hilo-d', FULL);
    const button = moreButton('hilo-d', '42');
    await press(button.action, 42, 666);
    expect(harness.sent).toHaveLength(0);
    expect(takeFullReply('hilo-d')).toBe(FULL);
  });

  it('nunca toca una aprobación pendiente', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-9', '42', '¿Permito shell?', { askScope: true });
    cacheFullReply('hilo-e', FULL);
    await press(moreButton('hilo-e', '42').action);
    await press('more:inventado');
    expect(await stateOf(pending)).toBe('pending');
    await press('approve:once:req-9');
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
  });
});

describe('«📖 Ver todo» retirado y el texto completo en el mismo hilo', () => {
  it('pedido con «más» escrito: el botón desaparece del mensaje recortado', async () => {
    const channel = await makeChannel();
    cacheFullReply('hilo-mas', FULL);
    const button = moreButton('hilo-mas', '42');
    await channel.send({
      channel: 'telegram',
      account: 'main',
      chatId: '42',
      text: 'Recorte…',
      buttons: [button],
    });
    const trimmedId = harness.sent.length;
    expect(harness.markups).toEqual([]);
    expect(takeFullReply('hilo-mas')).toBe(FULL);
    await vi.waitFor(
      () => expect(harness.markups).toEqual([{ chatId: 42, messageId: trimmedId, rows: 0 }]),
      { timeout: 4000 },
    );
    // Y la ficha ya no vale: pulsarlo avisa y no envía nada.
    const before = harness.sent.length;
    await press(button.action);
    expect(harness.sent.length).toBe(before);
  });

  it('una respuesta nueva del mismo hilo retira el botón de la anterior', async () => {
    const channel = await makeChannel();
    cacheFullReply('hilo-nuevo', FULL);
    const old = moreButton('hilo-nuevo', '42');
    await channel.send({
      channel: 'telegram',
      account: 'main',
      chatId: '42',
      text: 'Recorte 1',
      buttons: [old],
    });
    const oldId = harness.sent.length;
    cacheFullReply('hilo-nuevo', `${FULL} (otra)`);
    await vi.waitFor(
      () => expect(harness.markups).toEqual([{ chatId: 42, messageId: oldId, rows: 0 }]),
      { timeout: 4000 },
    );
  });

  it('el botón de otro hilo no se toca', async () => {
    const channel = await makeChannel();
    cacheFullReply('hilo-x', FULL);
    await channel.send({
      channel: 'telegram',
      account: 'main',
      chatId: '42',
      text: 'X',
      buttons: [moreButton('hilo-x', '42')],
    });
    cacheFullReply('hilo-y', FULL);
    takeFullReply('hilo-y');
    await new Promise((r) => setTimeout(r, 0));
    expect(harness.markups).toEqual([]);
  });

  it('responder al texto completo llega como respuesta al mensaje recortado (mismo hilo)', async () => {
    const inbound: Array<{ replyToMessageId?: string }> = [];
    const channel = new TelegramChannel({
      token: 'test-token',
      allowedUserIds: [7],
      approvalTtlMs: 60_000,
    });
    await channel.start({
      onMessage: (m: { replyToMessageId?: string }) => void inbound.push(m),
      log: () => {},
    } as never);
    cacheFullReply('hilo-alias', FULL);
    const button = moreButton('hilo-alias', '42');
    const trimmedId = await press(button.action);
    const fullId = harness.sent.length;
    expect(harness.sent[fullId - 1]?.text).toContain('Punto clave');
    const onMessage = harness.handlers.get('message');
    if (!onMessage) throw new Error('no message handler');
    const msg = (reply: number) => ({
      message: {
        message_id: 900 + reply,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: 'private' },
        from: { id: 7, first_name: 'Nico' },
        text: 'vale, ¿y lo segundo?',
        reply_to_message: { message_id: reply },
      },
      from: { id: 7, first_name: 'Nico' },
      chat: { id: 42, type: 'private' },
    });
    await onMessage(msg(fullId));
    await onMessage(msg(12345));
    await new Promise((r) => setTimeout(r, 0));
    expect(inbound.map((m) => m.replyToMessageId)).toEqual([String(trimmedId), '12345']);
  });
});
