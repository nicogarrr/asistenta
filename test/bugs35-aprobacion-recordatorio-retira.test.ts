/**
 * bugs-35: el «⏳ Sigo esperando…» de #2324 se quedaba en el chat después de contestar,
 * caducar o cancelar la aprobación, pidiendo «pulsa ✅ o ❌» de algo ya cerrado.
 * Ahora se borra (o, si Telegram no deja, se reescribe). Mismo doble de grammY que #2324.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../src/channels/telegram.js';

const harness = vi.hoisted(() => {
  const sent: Array<{
    chatId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
    replyTo?: number;
  }> = [];
  const edits: Array<{
    chatId: number;
    messageId: number;
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  const answers: string[] = [];
  const deletes: Array<{ chatId: number; messageId: number }> = [];
  const deleteControl = { fail: false };
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
          replyTo: (other as { reply_to_message_id?: number } | undefined)?.reply_to_message_id,
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
      deleteMessage: async (chatId: number, messageId: number) => {
        if (deleteControl.fail) {
          throw new FakeGrammyError(400, "Bad Request: message can't be deleted");
        }
        deletes.push({ chatId, messageId });
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
    deletes,
    deleteControl,
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
  harness.deleteControl.fail = false;
  harness.answers.length = 0;
});

async function makeChannel(approvalTtlMs: number, approvalNudgeMs?: number) {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7],
    approvalTtlMs,
    ...(approvalNudgeMs !== undefined ? { approvalNudgeMs } : {}),
  });
  await channel.start({ onMessage: () => {}, log: () => {} });
  return channel;
}

function press(data: string, chatId = 42): void {
  const handler = harness.handlers.get('callback_query:data');
  if (!handler) throw new Error('sin manejador de botones');
  handler({
    callbackQuery: { data, message: { chat: { id: chatId }, message_id: 900 } },
    from: { id: 7 },
    answerCallbackQuery: async () => true,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nudged(channel: TelegramChannel, id: string, chat: number) {
  const pending = channel.offerApproval(id, String(chat), '¿Permito shell?');
  await vi.waitFor(() => expect(harness.sent.filter((m) => m.chatId === chat).length).toBe(1));
  await vi.waitFor(
    () =>
      expect(harness.sent.some((m) => m.chatId === chat && m.text.startsWith('⏳ Sigo'))).toBe(
        true,
      ),
    { timeout: 3500 },
  );
  const nudgeId = harness.sent.findIndex((m) => m.chatId === chat && m.text.startsWith('⏳')) + 1;
  return { pending, nudgeId };
}

describe(
  'recordatorio de aprobación: se retira al cerrarse la pregunta',
  { timeout: 15_000 },
  () => {
    it('al pulsar ✅ se borra el «⏳ Sigo esperando…»', async () => {
      const channel = await makeChannel(6000, 100);
      const { pending, nudgeId } = await nudged(channel, 'b1', 51);
      press('approve:b1', 51);
      await expect(pending).resolves.toMatchObject({ approved: true });
      await vi.waitFor(
        () => expect(harness.deletes).toContainEqual({ chatId: 51, messageId: nudgeId }),
        { timeout: 3500 },
      );
    });

    it('al caducar también se borra (el aviso de caducada queda en la pregunta)', async () => {
      const channel = await makeChannel(1500, 100);
      const { pending, nudgeId } = await nudged(channel, 'b2', 52);
      await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
      await vi.waitFor(
        () => expect(harness.deletes).toContainEqual({ chatId: 52, messageId: nudgeId }),
        { timeout: 3500 },
      );
    });

    it('con /stop (cancelar) también se borra', async () => {
      const channel = await makeChannel(6000, 100);
      const { pending, nudgeId } = await nudged(channel, 'b3', 53);
      channel.cancelForChat('53');
      await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
      await vi.waitFor(
        () => expect(harness.deletes).toContainEqual({ chatId: 53, messageId: nudgeId }),
        { timeout: 3500 },
      );
    });

    it('si Telegram no deja borrarlo, se reescribe sin pedir que pulses nada', async () => {
      const channel = await makeChannel(6000, 100);
      const { pending, nudgeId } = await nudged(channel, 'b4', 54);
      harness.deleteControl.fail = true;
      press('deny:b4', 54);
      await expect(pending).resolves.toMatchObject({ approved: false });
      await vi.waitFor(
        () => {
          const e = harness.edits.find((x) => x.chatId === 54 && x.messageId === nudgeId);
          expect(e).toBeDefined();
          expect(e?.text).not.toContain('pulsa');
        },
        { timeout: 3500 },
      );
    });

    it('si se contesta antes del recordatorio, no se manda ni se borra nada de más', async () => {
      const channel = await makeChannel(6000, 800);
      const pending = channel.offerApproval('b5', '55', '¿Permito tv?');
      await vi.waitFor(() => expect(harness.sent.some((m) => m.chatId === 55)).toBe(true));
      press('approve:b5', 55);
      await expect(pending).resolves.toMatchObject({ approved: true });
      await sleep(1200);
      expect(harness.sent.some((m) => m.chatId === 55 && m.text.startsWith('⏳'))).toBe(false);
    });
  },
);
