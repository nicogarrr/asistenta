/**
 * Botón «🔄 Buscar actualización ahora» en el canal de Telegram: va por su propio camino
 * (nunca toca aprobaciones), contesta al toque en el acto y solo para usuarios
 * permitidos. gramY de mentira, sin red.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UPDATE_CALLBACK } from '../src/autoupdate-boton.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import type { ChannelAdapter, ChannelHandlers } from '../src/channels/types.js';

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
  harness.answers.length = 0;
});

type Press = { channel: string; chatId: string; userId: string; data: string };
type UpdateReply = { notice: string; reply?: string };

async function makeChannel(
  onUpdateButton?: (p: Press) => Promise<UpdateReply>,
): Promise<TelegramChannel> {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7, 8],
    approvalTtlMs: 60_000,
  });
  await channel.start({
    onMessage: () => {},
    log: () => {},
    ...(onUpdateButton ? { onUpdateButton } : {}),
  } as ChannelHandlers);
  return channel;
}

async function press(data: string, chat: number | null = 7, userId = 7): Promise<void> {
  const handler = harness.handlers.get('callback_query:data');
  if (!handler) throw new Error('no callback handler');
  await handler({
    callbackQuery: {
      data,
      message: chat === null ? undefined : { chat: { id: chat }, message_id: 1 },
    },
    from: { id: userId },
    answerCallbackQuery: async (args?: { text?: string }) => {
      harness.answers.push(args?.text ?? '');
      return true;
    },
  });
}

describe('botón Buscar actualización en Telegram', () => {
  it('el dueño pulsa: el aviso del botón dice «Buscando actualización…» y no manda nada más', async () => {
    const presses: Press[] = [];
    await makeChannel(async (p) => {
      presses.push(p);
      return { notice: 'Buscando actualización…' };
    });
    await press(UPDATE_CALLBACK);
    expect(presses).toEqual([
      { channel: 'telegram', chatId: '7', userId: '7', data: UPDATE_CALLBACK },
    ]);
    expect(harness.answers).toEqual(['Buscando actualización…']);
    expect(harness.sent).toEqual([]);
  });

  it('con explicación (apagada, fuera de Windows): aviso corto y el detalle como mensaje', async () => {
    await makeChannel(async () => ({
      notice: 'La autoactualización está apagada.',
      reply: 'Para encenderla: pa autoupdate on.',
    }));
    await press(UPDATE_CALLBACK);
    expect(harness.answers).toEqual(['La autoactualización está apagada.']);
    expect(harness.sent.map((s) => [s.chatId, s.text])).toEqual([
      [7, 'Para encenderla: pa autoupdate on.'],
    ]);
  });

  it('alguien no permitido: «Este asistente es privado.» y no se busca nada', async () => {
    let called = false;
    await makeChannel(async () => {
      called = true;
      return { notice: 'x' };
    });
    await press(UPDATE_CALLBACK, 9, 9);
    expect(called).toBe(false);
    expect(harness.answers).toEqual(['Este asistente es privado.']);
  });

  it('sin el manejador del daemon o sin chat de origen: botón caducado, nada se lanza', async () => {
    await makeChannel();
    await press(UPDATE_CALLBACK);
    expect(harness.answers[0]).toContain('ya no sirve');
    harness.answers.length = 0;
    let called = false;
    await makeChannel(async () => {
      called = true;
      return { notice: 'x' };
    });
    await press(UPDATE_CALLBACK, null);
    expect(called).toBe(false);
  });

  it('si el daemon falla, el aviso lo dice en claro', async () => {
    await makeChannel(async () => {
      throw new Error('boom');
    });
    await press(UPDATE_CALLBACK);
    expect(harness.answers[0]).toContain('No he podido buscar la actualización');
  });

  it('el registro de canales pasa onUpdateButton al adaptador', async () => {
    let got: ChannelHandlers | undefined;
    const adapter = {
      name: 'fake',
      account: 'a',
      start: async (h: ChannelHandlers) => {
        got = h;
      },
      stop: async () => {},
      send: async () => null,
      isReady: () => true,
    } as unknown as ChannelAdapter;
    const registry = new ChannelRegistry();
    registry.register(adapter);
    await registry.startAll({
      onMessage: () => {},
      onUpdateButton: async () => ({ notice: 'ok' }),
      log: () => {},
    } as ChannelHandlers);
    expect(
      await got?.onUpdateButton?.({ channel: 'telegram', chatId: '7', userId: '7', data: 'u' }),
    ).toEqual({ notice: 'ok' });
  });
});

describe('dónde sale el botón (cableado en el daemon)', () => {
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

  it('el daemon atiende el botón con la misma comprobación de dueño que los demás', () => {
    expect(cli).toMatch(/onUpdateButton: async \(press\)/);
    expect(cli).toMatch(/isOwner: isOwnerDm\(press, vigilanteOwnerId\)/);
    expect(cli).toContain("'autoupdate', 'boton'");
  });

  it('/estado y /actualizacion lo llevan debajo, solo para el dueño en privado', () => {
    const uses = cli.match(
      /buttons: isOwnerDm\(inbound, vigilanteOwnerId\) \? updateButtons\(\) : undefined/g,
    );
    expect(uses).toHaveLength(2);
  });
});
