import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Streaming por borrador, aprobaciones en el topic correcto, caché de la respuesta
 * completa y entrega texto+voz.
 *
 * El doble de grammY solo cuenta y captura las llamadas: no hay token ni red. Los
 * temporizadores se falsean donde importa para no pagar el espaciado global de 1,1 s
 * que el adaptador comparte con Telegram de verdad.
 */
const harness = vi.hoisted(() => {
  type Sent = { chatId: number; text: string; threadId?: number };
  type Edit = { chatId: number; messageId: number; text: string };
  type MarkupEdit = { chatId: number; messageId: number; keyboard: unknown[] };
  type Voice = { chatId: number; threadId?: number; caption?: string; duration?: number };

  const state = {
    sent: [] as Sent[],
    edits: [] as Edit[],
    markupEdits: [] as MarkupEdit[],
    voices: [] as Voice[],
    /** Errores que la próxima edición de texto debe lanzar, en orden. */
    editErrors: [] as Error[],
    nextMessageId: 100,
  };

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
    readonly filename: string | undefined;
    constructor(data: unknown, filename?: string) {
      this.data = data;
      this.filename = filename;
    }
  }

  class FakeBot {
    readonly api = {
      config: { use: () => ({}) },
      sendMessage: async (
        chatId: number,
        text: string,
        options?: { message_thread_id?: number },
      ) => {
        state.sent.push({ chatId, text, threadId: options?.message_thread_id });
        return { message_id: state.nextMessageId++ };
      },
      editMessageText: async (chatId: number, messageId: number, text: string) => {
        state.edits.push({ chatId, messageId, text });
        const error = state.editErrors.shift();
        if (error) throw error;
        return true;
      },
      editMessageReplyMarkup: async (
        chatId: number,
        messageId: number,
        options?: { reply_markup?: { inline_keyboard: unknown[] } },
      ) => {
        state.markupEdits.push({
          chatId,
          messageId,
          keyboard: options?.reply_markup?.inline_keyboard ?? [],
        });
        return true;
      },
      sendVoice: async (
        chatId: number,
        _file: FakeInputFile,
        options?: { caption?: string; duration?: number; message_thread_id?: number },
      ) => {
        state.voices.push({
          chatId,
          threadId: options?.message_thread_id,
          caption: options?.caption,
          duration: options?.duration,
        });
        return { message_id: state.nextMessageId++ };
      },
      setMyCommands: async () => true,
    };

    on(): void {}
    catch(): void {}
    async start(opts?: {
      onStart?: (me: { id: number; username: string }) => void;
    }): Promise<void> {
      opts?.onStart?.({ id: 1, username: 'telegram_v2_test_bot' });
    }
    async stop(): Promise<void> {}
  }

  return {
    state,
    FakeBot,
    FakeGrammyError,
    FakeHttpError,
    FakeInlineKeyboard,
    FakeInputFile,
  };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeGrammyError,
  HttpError: harness.FakeHttpError,
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: harness.FakeInputFile,
}));

import {
  cacheFullReply,
  isMoreRequest,
  TelegramChannel,
  takeFullReply,
} from '../src/channels/telegram.js';

const state = harness.state;

function makeChannel(approvalTtlMs = 60_000): TelegramChannel {
  return new TelegramChannel({ token: 'test-token', allowedUserIds: [7], approvalTtlMs });
}

beforeEach(() => {
  state.sent.length = 0;
  state.edits.length = 0;
  state.markupEdits.length = 0;
  state.voices.length = 0;
  state.editErrors.length = 0;
  state.nextMessageId = 100;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('streamDraft', () => {
  it('envía la primera versión y edita las siguientes sobre el mismo mensaje', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();

    const first = await channel.streamDraft(42, '7', 'Hola');
    expect(first).toBe('100');
    expect(state.sent).toEqual([{ chatId: 42, text: 'Hola', threadId: 7 }]);
    expect(state.edits).toHaveLength(0);

    const second = channel.streamDraft(42, '7', 'Hola mundo');
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(second).resolves.toBe('100');
    expect(state.sent).toHaveLength(1);
    expect(state.edits).toEqual([{ chatId: 42, messageId: 100, text: 'Hola mundo' }]);
  });

  it('respeta minIntervalMs y aplica el último texto cuando toca', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();

    await channel.streamDraft(42, undefined, 'A');
    const firstEdit = channel.streamDraft(42, undefined, 'AB');
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(firstEdit).resolves.toBe('100');
    expect(state.edits).toHaveLength(1);

    // Demasiado pronto: no se llama a la Bot API, pero el mensaje sigue vivo.
    await expect(channel.streamDraft(42, undefined, 'ABC')).resolves.toBe('100');
    expect(state.edits).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_200);
    await expect(channel.streamDraft(42, undefined, 'ABCD')).resolves.toBe('100');
    expect(state.edits.map((edit) => edit.text)).toEqual(['AB', 'ABCD']);
    expect(state.sent).toHaveLength(1);
  });

  it('no edita si el texto no cambió', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();

    await channel.streamDraft(42, undefined, 'mismo texto');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(channel.streamDraft(42, undefined, 'mismo texto')).resolves.toBe('100');

    expect(state.sent).toHaveLength(1);
    expect(state.edits).toHaveLength(0);
  });

  it('tolera "message is not modified" y "message can\'t be edited"', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();

    await channel.streamDraft(42, undefined, 'A');

    state.editErrors.push(
      new harness.FakeGrammyError(
        400,
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      ),
    );
    const notModified = channel.streamDraft(42, undefined, 'AB');
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(notModified).resolves.toBe('100');

    await vi.advanceTimersByTimeAsync(1_200);
    state.editErrors.push(new harness.FakeGrammyError(400, "Bad Request: message can't be edited"));
    const tooOld = channel.streamDraft(42, undefined, 'ABC');
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(tooOld).resolves.toBe('100');
  });

  it('finishDraft aplica la versión final y abre un borrador nuevo después', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();

    await channel.streamDraft(42, undefined, 'parcial');
    const finish = channel.finishDraft(42, '100', 'respuesta completa');
    await vi.advanceTimersByTimeAsync(1_100);
    await finish;
    expect(state.edits).toEqual([{ chatId: 42, messageId: 100, text: 'respuesta completa' }]);

    // El estado se olvidó: el siguiente texto crea otra burbuja, no edita la anterior.
    const next = channel.streamDraft(42, undefined, 'otra respuesta');
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(next).resolves.toBe('101');
    expect(state.sent).toHaveLength(2);
  });
});

describe('offerApproval', () => {
  it('manda la pregunta y los botones al topic indicado', async () => {
    const channel = makeChannel();
    const pending = channel.offerApproval('req-1', '42', '¿Permito shell?', {
      askScope: true,
      threadId: '77',
    });

    await vi.waitFor(() => {
      expect(state.sent).toHaveLength(1);
    });
    expect(state.sent[0]).toMatchObject({ chatId: 42, text: '¿Permito shell?', threadId: 77 });

    channel.cancelApprovals();
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('al caducar deja "Caducada" y retira el teclado', async () => {
    vi.useFakeTimers();
    const channel = makeChannel(1_000);
    const pending = channel.offerApproval('req-2', '42', '¿Permito shell?', { threadId: '77' });

    await vi.advanceTimersByTimeAsync(0);
    expect(state.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ approved: false, scope: 'once' });

    // Los dos avisos visuales pasan por el espaciado global de la Bot API.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.edits).toEqual([{ chatId: 42, messageId: 100, text: 'Caducada' }]);
    expect(state.markupEdits).toEqual([{ chatId: 42, messageId: 100, keyboard: [] }]);
  });
});

describe('sendTextAndVoice', () => {
  it('entrega primero el texto y después la voz, en el mismo topic', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    const audio = {
      mimeType: 'audio/mpeg',
      data: Buffer.from('voz').toString('base64'),
      durationSeconds: 2,
    };

    const pending = channel.sendTextAndVoice(
      {
        channel: 'telegram',
        account: 'main',
        chatId: '42',
        threadId: '7',
        text: 'Aquí tienes la respuesta.',
      },
      audio,
    );
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(pending).resolves.toBe('100');

    expect(state.sent[0]).toMatchObject({ text: 'Aquí tienes la respuesta.', threadId: 7 });
    expect(state.voices).toHaveLength(1);
    expect(state.voices[0]).toMatchObject({ chatId: 42, threadId: 7 });
  });

  it('pasa a sendVoice la duración real redondeada al alza (la burbuja nunca sale a 0:00)', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    const audio = {
      mimeType: 'audio/mpeg',
      data: Buffer.from('voz').toString('base64'),
      durationSeconds: 2.2,
    };
    const pending = channel.sendTextAndVoice(
      { channel: 'telegram', account: 'main', chatId: '42', text: 't' },
      audio,
    );
    await vi.advanceTimersByTimeAsync(2_400);
    await expect(pending).resolves.toBe('100');
    expect(state.voices).toHaveLength(1);
    expect(state.voices[0]?.duration).toBe(3);
  });

  it('sin duración conocida (0) no declara ninguna: nunca un 0:00 falso', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    const audio = {
      mimeType: 'audio/mpeg',
      data: Buffer.from('voz').toString('base64'),
      durationSeconds: 0,
    };
    const pending = channel.sendTextAndVoice(
      { channel: 'telegram', account: 'main', chatId: '42', text: 't' },
      audio,
    );
    await vi.advanceTimersByTimeAsync(2_400);
    await expect(pending).resolves.toBe('100');
    expect(state.voices).toHaveLength(1);
    expect(state.voices[0]?.duration).toBeUndefined();
  });

  it('una nota de voz vacía no se envía: el texto sale y la voz se descarta', async () => {
    vi.useFakeTimers();
    const channel = makeChannel();
    const audio = { mimeType: 'audio/mpeg', data: '', durationSeconds: 2 };
    const pending = channel.sendTextAndVoice(
      { channel: 'telegram', account: 'main', chatId: '42', text: 't' },
      audio,
    );
    await vi.advanceTimersByTimeAsync(2_400);
    await expect(pending).resolves.toBe('100');
    expect(state.sent).toHaveLength(1);
    expect(state.voices).toHaveLength(0);
  });
});

describe('caché de respuesta completa', () => {
  it('guarda por hilo y se consume al pedirla', () => {
    cacheFullReply('v2:consume', 'La respuesta entera.');
    expect(takeFullReply('v2:consume')).toBe('La respuesta entera.');
    expect(takeFullReply('v2:consume')).toBeNull();
    expect(takeFullReply('v2:otro')).toBeNull();
  });

  it('caduca a los 10 minutos', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    cacheFullReply('v2:caduca', 'texto');
    // Justo antes del límite sigue disponible; en el límite exacto ya no.
    vi.setSystemTime(1_000_000 + 10 * 60_000 - 1);
    expect(takeFullReply('v2:caduca')).toBe('texto');

    vi.setSystemTime(1_000_000);
    cacheFullReply('v2:caduca-2', 'texto 2');
    vi.setSystemTime(1_000_000 + 10 * 60_000);
    expect(takeFullReply('v2:caduca-2')).toBeNull();
  });

  it('conserva solo las 24 entradas más recientes', () => {
    for (let i = 0; i < 40; i++) cacheFullReply(`v2:tope:${i}`, `respuesta ${i}`);
    expect(takeFullReply('v2:tope:15')).toBeNull();
    expect(takeFullReply('v2:tope:16')).toBe('respuesta 16');
    expect(takeFullReply('v2:tope:39')).toBe('respuesta 39');
  });
});

describe('isMoreRequest', () => {
  it('reconoce las variantes en español, con o sin acentos', () => {
    for (const text of [
      'más',
      'Dime más',
      'DIME MÁS.',
      'mas',
      'dame el detalle',
      'quiero detalles',
      'sigue',
      'continúa',
      'continua por favor',
      'el resto',
      'cuéntame más',
    ]) {
      expect(isMoreRequest(text)).toBe(true);
    }
  });

  it('no confunde palabras que contienen las mismas letras', () => {
    for (const text of ['', 'hola', 'sigues ahí', 'detallado', 'demasiado', 'resto', 'másomenos']) {
      expect(isMoreRequest(text)).toBe(false);
    }
  });

  it('una frase con «más» o «sigue» dentro es un encargo nuevo, no «el resto»', () => {
    for (const text of [
      'sigue buscando vuelos a Roma',
      'pon la música más alta',
      'quiero más café en la lista de la compra',
      '¿cuál es más barato?',
      'dame más detalles del vuelo de mañana',
    ]) {
      expect(isMoreRequest(text)).toBe(false);
    }
    for (const text of ['más, por favor', 'vale, sigue', 'dime el resto', 'sigue, porfa']) {
      expect(isMoreRequest(text)).toBe(true);
    }
  });
});
