/**
 * Approval buttons on Telegram: the pure callback_data grammar plus the promise
 * wiring, exercised against a hand-rolled gramY stand-in.
 *
 * The stand-in exists only to capture what the adapter would send and to feed
 * button presses back in. The Bot constructor and long polling are never reached,
 * so no token and no network are involved: the resolution logic is what is under
 * test, not Telegram.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApprovalChoice,
  type ApprovalScope,
  parseApprovalCallback,
  TelegramChannel,
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
  const handlers = new Map<string, (ctx: unknown) => unknown>();

  /** Mirrors gramY's InlineKeyboard: one row by default, text() fills the last row. */
  class FakeInlineKeyboard {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [[]];
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
});

let nextMessageId = 100;

async function makeChannel(approvalTtlMs = 60_000): Promise<TelegramChannel> {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7],
    approvalTtlMs,
  });
  await channel.start({
    onMessage: () => {},
    log: () => {},
  });
  return channel;
}

/** Feed one callback_query through the registered gramY handler; returns its message id. */
function press(data: string, userId = 7, chatId = 42): number {
  const handler = harness.handlers.get('callback_query:data');
  if (!handler) throw new Error('the adapter did not register a callback handler');
  const messageId = nextMessageId++;
  handler({
    callbackQuery: {
      data,
      message: { chat: { id: chatId }, message_id: messageId },
    },
    from: { id: userId },
    answerCallbackQuery: async (args?: { text?: string }) => {
      harness.answers.push(args?.text ?? '');
      return true;
    },
  });
  return messageId;
}

/** Resolves 'settled' if the promise settles within 50ms, else 'pending'. */
async function stateOf(pending: Promise<ApprovalChoice>): Promise<'settled' | 'pending'> {
  return Promise.race([
    pending.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => {
      setTimeout(() => resolve('pending'), 50);
    }),
  ]);
}

describe('parseApprovalCallback', () => {
  it('entiende los cuatro botones nuevos', () => {
    expect(parseApprovalCallback('approve:once:abc')).toEqual({ id: 'abc', scope: 'once' });
    expect(parseApprovalCallback('approve:session:abc')).toEqual({ id: 'abc', scope: 'session' });
    expect(parseApprovalCallback('approve:always:abc')).toEqual({ id: 'abc', scope: 'always' });
    // Denegar no lleva alcance propio; se reporta como 'once', que es exactamente
    // la forma de una denegación ({ approved: false, scope: 'once' }).
    expect(parseApprovalCallback('deny:abc')).toEqual({ id: 'abc', scope: 'once' });
  });

  it('mantiene el formato antiguo approve:<id> como una sola vez', () => {
    expect(parseApprovalCallback('approve:abc')).toEqual({ id: 'abc', scope: 'once' });
  });

  it('lee el id entero, con dos puntos, como hacía el manejador antiguo', () => {
    expect(parseApprovalCallback('approve:once:parte1:parte2')).toEqual({
      id: 'parte1:parte2',
      scope: 'once',
    });
    expect(parseApprovalCallback('approve:parte1:parte2')).toEqual({
      id: 'parte1:parte2',
      scope: 'once',
    });
    expect(parseApprovalCallback('deny:parte1:parte2')).toEqual({
      id: 'parte1:parte2',
      scope: 'once',
    });
  });

  it('rechaza formatos basura', () => {
    for (const junk of [
      '',
      'approve',
      'deny',
      'approve:',
      'deny:',
      'approve:once:',
      'approve:session:',
      'approve:always:',
      'foo:bar',
      'once:abc',
      'APPROVE:once:abc',
    ]) {
      expect(parseApprovalCallback(junk)).toBeNull();
    }
  });
});

describe('offerApproval con askScope', () => {
  it('muestra los cuatro botones con el callback_data del contrato', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-1', '42', '¿Permito shell?', { askScope: true });
    await vi.waitFor(() => {
      expect(harness.sent.find((m) => m.text === '¿Permito shell?')).toBeDefined();
    });
    const message = harness.sent.find((m) => m.text === '¿Permito shell?');
    expect(message?.keyboard[0]).toEqual([
      { text: 'Una vez', callback_data: 'approve:once:req-1' },
      { text: 'Esta sesión', callback_data: 'approve:session:req-1' },
      { text: 'Siempre', callback_data: 'approve:always:req-1' },
      { text: 'Denegar', callback_data: 'deny:req-1' },
    ]);
    channel.cancelApprovals();
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('resuelve con el alcance del botón pulsado', async () => {
    const channel = await makeChannel();
    const once = channel.offerApproval('req-1', '42', '¿Permito a?', { askScope: true });
    const session = channel.offerApproval('req-2', '42', '¿Permito b?', { askScope: true });
    const always = channel.offerApproval('req-3', '42', '¿Permito c?', { askScope: true });
    const deny = channel.offerApproval('req-4', '42', '¿Permito d?', { askScope: true });

    press('approve:once:req-1');
    press('approve:session:req-2');
    press('approve:always:req-3');
    press('deny:req-4');

    const oneShot: ApprovalChoice = { approved: true, scope: 'once' };
    const sessionScope: ApprovalScope = 'session';
    await expect(once).resolves.toEqual(oneShot);
    await expect(session).resolves.toEqual({ approved: true, scope: sessionScope });
    await expect(always).resolves.toEqual({ approved: true, scope: 'always' });
    await expect(deny).resolves.toEqual({ approved: false, scope: 'once' });
    expect(harness.answers).toContain('✅ Aprobado para esta sesión');
    expect(harness.answers).toContain('✅ Aprobado siempre');
    expect(harness.answers).toContain('❌ Denegado');
  });

  it('edita el mensaje con el veredicto y quita los botones', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-1', '42', '¿Permito shell?', { askScope: true });
    const messageId = press('approve:session:req-1');
    await expect(pending).resolves.toEqual({ approved: true, scope: 'session' });
    await vi.waitFor(
      () => {
        const edit = harness.edits.find((e) => e.messageId === messageId);
        expect(edit?.text).toBe('✅ Aprobado para esta sesión');
        expect(edit?.keyboard).toEqual([]);
      },
      { timeout: 8_000 },
    );
  });
});

describe('offerApproval sin askScope', () => {
  it('mantiene los dos botones de siempre', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-1', '42', '¿Permito shell?');
    await vi.waitFor(() => {
      expect(harness.sent.find((m) => m.text === '¿Permito shell?')).toBeDefined();
    });
    const message = harness.sent.find((m) => m.text === '¿Permito shell?');
    expect(message?.keyboard[0]).toEqual([
      { text: 'Permitir', callback_data: 'approve:req-1' },
      { text: 'Denegar', callback_data: 'deny:req-1' },
    ]);
    channel.cancelApprovals();
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('resuelve approve y deny como una sola vez', async () => {
    const channel = await makeChannel();
    const ok = channel.offerApproval('req-1', '42', '¿Permito a?');
    const no = channel.offerApproval('req-2', '42', '¿Permito b?');
    press('approve:req-1');
    press('deny:req-2');
    await expect(ok).resolves.toEqual({ approved: true, scope: 'once' });
    await expect(no).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('una segunda pulsación no vuelve a decidir', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-1', '42', '¿Permito a?');
    press('approve:req-1');
    press('approve:req-1');
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
    expect(harness.answers).toContain('That request is no longer pending.');
  });
});

describe('caducidad y cancelación', () => {
  it('resuelve como denegado cuando caduca', async () => {
    const channel = await makeChannel(30);
    const pending = channel.offerApproval('req-1', '42', '¿Permito a?', { askScope: true });
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('cancelForChat solo cancela ese chat y cancelApprovals el resto', async () => {
    const channel = await makeChannel();
    const here = channel.offerApproval('req-1', '42', '¿Permito a?', { askScope: true });
    const elsewhere = channel.offerApproval('req-2', '99', '¿Permito b?', { askScope: true });
    channel.cancelForChat('42');
    await expect(here).resolves.toEqual({ approved: false, scope: 'once' });
    expect(await stateOf(elsewhere)).toBe('pending');
    channel.cancelApprovals();
    await expect(elsewhere).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('ignora las pulsaciones de quien no está autorizado', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-1', '42', '¿Permito a?', { askScope: true });
    press('approve:always:req-1', 99);
    expect(await stateOf(pending)).toBe('pending');
    expect(harness.answers).toContain('Este asistente es privado.');
    channel.cancelApprovals();
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
  });
});

describe('aprobación ligada a su chat', () => {
  it('un botón pulsado desde otro chat no la resuelve ni la consume', async () => {
    const channel = await makeChannel();
    const pending = channel.offerApproval('req-x', '42', '¿Permito x?', { askScope: true });
    press('approve:always:req-x', 7, 999);
    expect(await stateOf(pending)).toBe('pending');
    expect(harness.answers).toContain('That request is no longer pending.');
    // El botón legítimo en su chat sigue funcionando.
    press('approve:once:req-x', 7, 42);
    await expect(pending).resolves.toEqual({ approved: true, scope: 'once' });
  });
});
