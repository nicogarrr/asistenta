/**
 * Grok Bot avisa otra vez cuando el Bot sigue esperándote. Aquí: una aprobación sin
 * respuesta se recuerda una vez (respondiendo al mensaje de los botones) antes de caducar.
 * Mismo doble de grammY que approval-buttons.test.ts: sin red ni token.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_NUDGE_DEFAULT_MS,
  approvalNudgeText,
  TelegramChannel,
} from '../src/channels/telegram.js';

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

beforeEach(() => {
  harness.sent.length = 0;
  harness.edits.length = 0;
});

describe(
  'aprobación sin respuesta: un recordatorio antes de caducar (Grok Bot)',
  { timeout: 15_000 },
  () => {
    it('sin respuesta, recuerda una vez respondiendo a la pregunta, sin botones', async () => {
      const channel = await makeChannel(4000, 100);
      const pending = channel.offerApproval('r1', '42', '¿Permito shell?');
      await vi.waitFor(() => expect(harness.sent.length).toBe(1));
      const askId = 1; // message_id del primer envío en el doble
      // Telegram va con su propio ritmo de envío por chat: se espera a que salga.
      await vi.waitFor(() => expect(harness.sent.length).toBe(2), { timeout: 3500 });
      const nudge = harness.sent[1];
      expect(nudge?.text.startsWith('⏳ Sigo esperando tu respuesta')).toBe(true);
      expect(nudge?.replyTo).toBe(askId);
      expect(nudge?.keyboard).toEqual([]);
      channel.cancelApprovals();
      await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
      // Solo una vez.
      await sleep(100);
      expect(harness.sent.filter((m) => m.text.startsWith('⏳')).length).toBe(1);
    });

    it('si ya contestó, no recuerda nada', async () => {
      const channel = await makeChannel(4000, 100);
      const pending = channel.offerApproval('r2', '43', '¿Permito tv?');
      await vi.waitFor(() => expect(harness.sent.some((m) => m.chatId === 43)).toBe(true));
      press('approve:r2', 43);
      await expect(pending).resolves.toMatchObject({ approved: true });
      await sleep(1500);
      expect(harness.sent.some((m) => m.chatId === 43 && m.text.startsWith('⏳'))).toBe(false);
    });

    it('por defecto: a los 3 min si dura 4 o más; nunca si dura menos o con 0', () => {
      expect(APPROVAL_NUDGE_DEFAULT_MS).toBe(180_000);
      expect(approvalNudgeText(2)).toContain('en 2 min caduca y no hago nada');
    });

    it('con una aprobación corta (60 s) no hay recordatorio', async () => {
      const channel = await makeChannel(1500);
      const pending = channel.offerApproval('r3', '44', '¿Permito x?');
      await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
      await sleep(300);
      expect(harness.sent.some((m) => m.chatId === 44 && m.text.startsWith('⏳'))).toBe(false);
    });
  },
);
