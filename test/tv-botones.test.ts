/**
 * Mando de la tele en botones bajo /tv: mismas órdenes que /tv <orden>, solo el
 * dueño en privado, y nunca toca aprobaciones. gramY de mentira, sin red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramChannel } from '../src/channels/telegram.js';
import { parseTvCommand } from '../src/tv/natural.js';
import {
  TV_BUTTONS,
  TV_CALLBACK_PREFIX,
  tvButtonCommand,
  tvButtons,
} from '../src/tv/tv-chat-command.js';

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

type Press = { channel: string; chatId: string; userId: string; data: string };

async function makeChannel(onTvButton?: (p: Press) => Promise<string>): Promise<TelegramChannel> {
  const channel = new TelegramChannel({
    token: 'test-token',
    allowedUserIds: [7, 8],
    approvalTtlMs: 60_000,
  });
  await channel.start({
    onMessage: () => {},
    log: () => {},
    ...(onTvButton ? { onTvButton } : {}),
  });
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

describe('botones del mando: órdenes', () => {
  it('cada botón es una orden que el parser entiende', () => {
    for (const b of TV_BUTTONS) expect(parseTvCommand(b.order), b.id).not.toBeNull();
    expect(tvButtons().map((b) => b.action)).toEqual(
      TV_BUTTONS.map((b) => `${TV_CALLBACK_PREFIX}${b.id}`),
    );
    for (const b of tvButtons()) expect(Buffer.byteLength(b.action)).toBeLessThanOrEqual(64);
  });

  it('el dueño pulsa: corre la orden fija del botón', async () => {
    const run = vi.fn(async (t: string) => `ok ${t}`);
    expect(await tvButtonCommand('tv:off', { isOwner: true, run })).toBe('ok apaga la tele');
    expect(await tvButtonCommand('tv:netflix', { isOwner: true, run })).toBe('ok abre netflix');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('otro usuario o un grupo: no corre nada', async () => {
    const run = vi.fn(async () => 'x');
    expect(await tvButtonCommand('tv:off', { isOwner: false, run })).toMatch(/Solo el dueño/);
    expect(run).not.toHaveBeenCalled();
  });

  it('id desconocido o texto libre: no corre nada', async () => {
    const run = vi.fn(async () => 'x');
    for (const d of ['tv:apaga la tele', 'tv:', 'tv:rm -rf', 'more:off']) {
      expect(await tvButtonCommand(d, { isOwner: true, run })).toMatch(/ya no existe/);
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe('botones del mando: canal Telegram', () => {
  beforeEach(() => {
    harness.answers.length = 0;
  });

  it('la pulsación llega con chat y usuario, y el aviso es la respuesta', async () => {
    const got: Press[] = [];
    await makeChannel(async (p) => {
      got.push(p);
      return 'Volumen subido 3 pasos.';
    });
    await press('tv:vup', 7, 7);
    expect(got).toEqual([{ channel: 'telegram', chatId: '7', userId: '7', data: 'tv:vup' }]);
    expect(harness.answers).toEqual(['Volumen subido 3 pasos.']);
  });

  it('usuario no permitido: ni llega', async () => {
    const got: Press[] = [];
    await makeChannel(async (p) => {
      got.push(p);
      return 'x';
    });
    await press('tv:off', 99, 99);
    expect(got).toEqual([]);
  });

  it('sin mensaje de origen (chat desconocido): no se ejecuta', async () => {
    const got: Press[] = [];
    await makeChannel(async (p) => {
      got.push(p);
      return 'x';
    });
    await press('tv:off', null, 7);
    expect(got).toEqual([]);
    expect(harness.answers[0] ?? '').toMatch(/ya no sirve/);
  });

  it('sin manejador de tele: lo dice y no rompe', async () => {
    await makeChannel();
    await press('tv:off');
    expect(harness.answers[0] ?? '').toMatch(/ya no sirve/);
  });

  it('si la orden falla, aviso corto y sin excepción', async () => {
    await makeChannel(async () => {
      throw new Error('boom');
    });
    await press('tv:on');
    expect(harness.answers[0] ?? '').toMatch(/No he podido/);
  });

  it('respuesta larga: no cabe en el aviso, llega entera como mensaje', async () => {
    harness.sent.length = 0;
    const long = `La tele está encendida. ${'a'.repeat(400)}`;
    await makeChannel(async () => long);
    await press('tv:status');
    expect(harness.answers).toEqual(['']);
    expect(harness.sent.map((m) => [m.chatId, m.text])).toEqual([[7, long]]);
  });

  it('el mando trae Pausa, Play y Estado, y Estado solo lee', async () => {
    const ids = TV_BUTTONS.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['pause', 'play', 'status']));
    const status = TV_BUTTONS.find((b) => b.id === 'status');
    expect(parseTvCommand(status?.order ?? '')).toEqual({ action: 'status' });
    expect(parseTvCommand('pausa')).toMatchObject({ action: 'media', command: 'pause' });
    expect(parseTvCommand('play')).toMatchObject({ action: 'media', command: 'play' });
  });
});

describe('botones del mando: orden lenta', () => {
  beforeEach(() => {
    harness.answers.length = 0;
    harness.sent.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('si tarda, contesta «Enviando…» al momento y manda el resultado como mensaje', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await makeChannel(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('Tele encendida.'), 12_000)),
    );
    const done = press('tv:on', 7, 7);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.answers).toEqual(['Enviando a la tele…']);
    expect(harness.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(harness.answers).toHaveLength(1);
    expect(harness.sent.map((m) => [m.chatId, m.text])).toEqual([[7, 'Tele encendida.']]);
  });

  it('si tarda y falla, el aviso de fallo llega como mensaje', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await makeChannel(
      () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('x')), 5_000)),
    );
    const done = press('tv:off', 7, 7);
    await vi.advanceTimersByTimeAsync(6_000);
    await done;
    expect(harness.answers).toEqual(['Enviando a la tele…']);
    expect(harness.sent.map((m) => m.text)).toEqual(['No he podido mandar la orden a la tele.']);
  });

  it('si es rápida, solo el aviso del botón (sin mensaje)', async () => {
    await makeChannel(async () => 'Silencio puesto.');
    await press('tv:mute');
    expect(harness.answers).toEqual(['Silencio puesto.']);
    expect(harness.sent).toEqual([]);
  });
});

describe('botones del mando: pulsados con Asistenta apagada', () => {
  async function pressOld(
    data: string,
    keyboardAgoS: number,
    answer: (args?: { text?: string }) => Promise<boolean>,
  ): Promise<void> {
    const handler = harness.handlers.get('callback_query:data');
    if (!handler) throw new Error('no callback handler');
    await handler({
      callbackQuery: {
        data,
        message: {
          chat: { id: 7 },
          message_id: 1,
          date: Math.floor(Date.now() / 1000) - keyboardAgoS,
        },
      },
      from: { id: 7 },
      answerCallbackQuery: answer,
    });
  }
  const tooOld = async (): Promise<boolean> => {
    throw new harness.FakeGrammyError(
      400,
      'Bad Request: query is too old and response timeout expired or query ID is invalid',
    );
  };

  it('Telegram dice que la pulsación es vieja: la tele no se toca y se dice claro', async () => {
    const calls: Press[] = [];
    await makeChannel(async (p) => {
      calls.push(p);
      return 'Netflix abierto.';
    });
    await pressOld('tv:netflix', 3600, tooOld);
    expect(calls).toEqual([]);
    expect(harness.sent.map((m) => m.text)).toEqual([
      'No he tocado la tele: ese botón se pulsó mientras Asistenta estaba apagada o sin conexión. Si aún lo quieres, púlsalo otra vez.',
    ]);
  });

  it('teclado viejo pero pulsación a tiempo: se ejecuta y el resultado llega', async () => {
    const calls: Press[] = [];
    await makeChannel(async (p) => {
      calls.push(p);
      return 'Silencio puesto.';
    });
    await pressOld('tv:mute', 3600, async (args) => {
      harness.answers.push(args?.text ?? '');
      return true;
    });
    expect(calls.map((c) => c.data)).toEqual(['tv:mute']);
    expect(harness.answers).toEqual(['Enviando a la tele…']);
    expect(harness.sent.map((m) => m.text)).toEqual(['Silencio puesto.']);
  });

  it('teclado de después de conectar: sin comprobación, igual que siempre', async () => {
    await makeChannel(async () => 'Silencio puesto.');
    await pressOld('tv:mute', -5, async (args) => {
      harness.answers.push(args?.text ?? '');
      return true;
    });
    expect(harness.answers).toEqual(['Silencio puesto.']);
    expect(harness.sent).toEqual([]);
  });
});
