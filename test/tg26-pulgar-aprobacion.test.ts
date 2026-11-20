/**
 * Un 👍 del dueño sobre una pregunta de aprobación pendiente (reacción, o «👍» a
 * secas citándola) vale como «✅ Una vez»: aprueba SOLO esa acción, una vez. Un ❤️
 * no aprueba; una pregunta sin `thumbOk` (una compra, un correo que firma él) no se
 * aprueba con 👍 nunca. grammy falseado, como en approval-buttons.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalChoice, TelegramChannel } from '../src/channels/telegram.js';
import { isThumbsUp } from '../src/channels/telegram-reacciones.js';

const harness = vi.hoisted(() => {
  const sent: Array<{
    chatId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const deletes: Array<{ chatId: number; messageId: number }> = [];
  const handlers = new Map<string, (ctx: unknown) => unknown>();

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
      config: { use: () => ({}) },
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
      editMessageText: async (chatId: number, messageId: number, text: string) => {
        edits.push({ chatId, messageId, text });
        return true;
      },
      deleteMessage: async (chatId: number, messageId: number) => {
        deletes.push({ chatId, messageId });
        return true;
      },
      setMyCommands: async () => true,
    };
    on(event: string, fn: (ctx: unknown) => unknown): void {
      handlers.set(event, fn);
    }
    catch(): void {}
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
    deletes,
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
  harness.deletes.length = 0;
});

async function makeChannel(approvalTtlMs = 60_000): Promise<TelegramChannel> {
  const channel = new TelegramChannel({ token: 'test-token', allowedUserIds: [7], approvalTtlMs });
  await channel.start({ onMessage: () => {}, log: () => {} });
  return channel;
}

/** El id (1-based) del mensaje enviado con ese texto, tal como lo asigna el bot falso. */
function sentIdOf(text: string): number {
  const idx = harness.sent.findIndex((m) => m.text === text);
  if (idx < 0) throw new Error(`no se envió «${text}»`);
  return idx + 1;
}

const emoji = (e: string) => ({ type: 'emoji', emoji: e });

async function react(messageId: number, added: string[], userId = 7): Promise<void> {
  const handler = harness.handlers.get('message_reaction');
  if (!handler) throw new Error('sin manejador de reacciones');
  await handler({
    messageReaction: {
      chat: { id: 42, type: 'private' },
      message_id: messageId,
      user: { id: userId, first_name: 'Nico' },
      date: 1_700_000_000,
      old_reaction: [],
      new_reaction: added.map(emoji),
    },
  });
}

async function replyText(text: string, replyToMessageId: number, userId = 7): Promise<void> {
  const handler = harness.handlers.get('message');
  if (!handler) throw new Error('sin manejador de mensajes');
  await handler({
    message: {
      message_id: 9_999,
      text,
      reply_to_message: { message_id: replyToMessageId, chat: { id: 42 } },
      chat: { id: 42, type: 'private' },
    },
    from: { id: userId, first_name: 'Nico' },
    chat: { id: 42, type: 'private' },
    me: { username: 'asistenta_test_bot', id: 1 },
    reply: async () => ({}),
  });
}

/** 'settled' si la promesa se resuelve en 50 ms; si no, 'pending'. */
async function stateOf(pending: Promise<ApprovalChoice>): Promise<'settled' | 'pending'> {
  return Promise.race([
    pending.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), 50);
    }),
  ]);
}

const PREGUNTA = '¿Abro example.com?';

function offerThumb(
  channel: TelegramChannel,
  id = 'req-1',
): { pending: Promise<ApprovalChoice>; ready: Promise<unknown> } {
  const pending = channel.offerApproval(id, '42', PREGUNTA, { askScope: true, thumbOk: true });
  const ready = vi.waitFor(() => expect(sentIdOf(PREGUNTA)).toBeGreaterThan(0));
  return { pending, ready };
}

describe('👍 sobre una pregunta de aprobación (thumbOk)', () => {
  it('una reacción 👍 la aprueba UNA vez y retira la pregunta', async () => {
    const channel = await makeChannel();
    const { pending, ready } = offerThumb(channel);
    await ready;
    await react(sentIdOf(PREGUNTA), ['👍']);
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    // La pregunta se retira como con el botón (borrada o marcada, nunca con botones vivos).
    const id = sentIdOf(PREGUNTA);
    await vi.waitFor(
      () =>
        expect(
          harness.deletes.some((d) => d.messageId === id) ||
            harness.edits.some((e) => e.messageId === id),
        ).toBe(true),
      { timeout: 5_000 },
    );
    await channel.stop();
  });

  it('«👍» escrito citando la pregunta también la aprueba una vez', async () => {
    const channel = await makeChannel();
    const { pending, ready } = offerThumb(channel);
    await ready;
    await replyText('👍', sentIdOf(PREGUNTA));
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    await channel.stop();
  });

  it('el 👍 con tono de piel vale; un ❤️ o un 🔥 NO aprueban', async () => {
    const channel = await makeChannel();
    const { pending, ready } = offerThumb(channel);
    await ready;
    const id = sentIdOf(PREGUNTA);
    await react(id, ['❤️']);
    await react(id, ['🔥']);
    expect(await stateOf(pending)).toBe('pending');
    await react(id, ['👍🏽']);
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    await channel.stop();
  });

  it('un segundo 👍 (o uno tardío tras resolver) no hace nada', async () => {
    const channel = await makeChannel();
    const { pending, ready } = offerThumb(channel);
    await ready;
    const id = sentIdOf(PREGUNTA);
    await react(id, ['👍']);
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    // No lanza ni vuelve a resolver: la aprobación ya no existe.
    await react(id, ['👍']);
    await replyText('👍', id);
    await channel.stop();
  });

  it('quien no es el dueño no aprueba con 👍', async () => {
    const channel = await makeChannel();
    const { pending, ready } = offerThumb(channel);
    await ready;
    await react(sentIdOf(PREGUNTA), ['👍'], 99);
    await replyText('👍', sentIdOf(PREGUNTA), 99);
    expect(await stateOf(pending)).toBe('pending');
    await channel.stop();
  });

  it('una aprobación sin thumbOk (una compra, un correo suyo) NO se aprueba con 👍', async () => {
    const channel = await makeChannel();
    const compra = 'Compra: 42,00 € en la tienda. ¿Confirmo?';
    const pending = channel.offerApproval('req-compra', '42', compra);
    await vi.waitFor(() => expect(sentIdOf(compra)).toBeGreaterThan(0));
    const id = sentIdOf(compra);
    await react(id, ['👍']);
    await replyText('👍', id);
    expect(await stateOf(pending)).toBe('pending');
    // El botón sigue siendo el camino.
    const press = harness.handlers.get('callback_query:data');
    press?.({
      callbackQuery: { data: 'approve:req-compra', message: { chat: { id: 42 }, message_id: id } },
      from: { id: 7 },
      answerCallbackQuery: async () => true,
    });
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    await channel.stop();
  });

  it('caducada, un 👍 ya no la aprueba', async () => {
    const channel = await makeChannel(80);
    const { pending, ready } = offerThumb(channel);
    await ready;
    const id = sentIdOf(PREGUNTA);
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
    await react(id, ['👍']);
    await replyText('👍', id);
    await channel.stop();
  });
});

describe('isThumbsUp', () => {
  it('reconoce el 👍 solo, con selector de variante o con tono de piel', () => {
    expect(isThumbsUp('👍')).toBe(true);
    expect(isThumbsUp('👍️')).toBe(true);
    expect(isThumbsUp('👍🏽')).toBe(true);
    expect(isThumbsUp(' 👍 ')).toBe(true);
    expect(isThumbsUp('❤️')).toBe(false);
    expect(isThumbsUp('👎')).toBe(false);
    expect(isThumbsUp('👍👍')).toBe(false);
    expect(isThumbsUp('vale 👍')).toBe(false);
    expect(isThumbsUp('')).toBe(false);
  });
});
