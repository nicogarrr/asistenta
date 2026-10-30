import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Una **negrita** que cruza el corte de 4000 de chunkText se cierra al final del
 * trozo y se reabre en el siguiente (antes ambos trozos la perdían). grammY falseado.
 */
const harness = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ text: string; parseMode?: string }>,
    /** Descripciones de 400 que el próximo sendMessage con parse_mode debe lanzar. */
    htmlErrors: [] as string[],
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
  class FakeBot {
    readonly api = {
      config: { use: () => ({}) },
      sendMessage: async (_chatId: number, text: string, options?: { parse_mode?: string }) => {
        if (options?.parse_mode && state.htmlErrors.length) {
          throw new FakeGrammyError(400, state.htmlErrors.shift() as string);
        }
        state.sent.push({ text, parseMode: options?.parse_mode });
        return { message_id: 1 };
      },
      setMyCommands: async () => true,
    };
    on(): void {}
    catch(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  class FakeInlineKeyboard {
    row(): this {
      return this;
    }
    text(): this {
      return this;
    }
  }
  return { state, FakeBot, FakeGrammyError, FakeInlineKeyboard };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeGrammyError,
  HttpError: class extends Error {},
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: class {},
}));

import { telegramHtml } from '../src/channels/formatters.js';
import { chunkText, TelegramChannel } from '../src/channels/telegram.js';

const channel = () => new TelegramChannel({ token: 't', allowedUserIds: [7] });
const state = harness.state;
const out = (text: string, format?: 'marks') => ({
  channel: 'telegram',
  account: 'a',
  chatId: '7',
  text,
  format,
});

/** Una sola línea larga: 3200 caracteres de prosa y una negrita que cruza los 4000. */
const longLine = `${'palabra '.repeat(400)}**${'negrita '.repeat(200).trim()}** fin`;

describe('chunkText con marcas: negrita partida por el corte', () => {
  beforeEach(() => {
    state.sent = [];
    state.htmlErrors = [];
  });

  it('cierra la negrita en el primer trozo y la reabre en el segundo', () => {
    const parts = chunkText(longLine, 4000, { marks: true });
    expect(parts.length).toBe(2);
    for (const p of parts) expect(Array.from(p).length).toBeLessThanOrEqual(4000);
    expect(parts[0]).toMatch(/negrita\*\*$/);
    expect(parts[1]?.startsWith('**negrita')).toBe(true);
    expect(telegramHtml(parts[0] as string)).toContain('<b>negrita');
    expect(telegramHtml(parts[1] as string)).toMatch(/^<b>negrita[^<]*<\/b> fin$/);
    // Nada se pierde: sin las marcas, los trozos son el texto original.
    const plain = (s: string) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    expect(plain(parts.join(' '))).toBe(plain(longLine));
  });

  it('una negrita que cruza dos cortes sale en negrita en los tres trozos', () => {
    const text = `${'a '.repeat(1000)}**${'b '.repeat(4500).trim()}** c`;
    const parts = chunkText(text, 4000, { marks: true });
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(Array.from(p).length).toBeLessThanOrEqual(4000);
      expect(telegramHtml(p)).toContain('<b>');
    }
  });

  it('sin marcas el troceo no cambia', () => {
    expect(chunkText(longLine, 4000)).toEqual(chunkText(longLine, 4000, { marks: false }));
    expect(chunkText(longLine, 4000).join('')).not.toMatch(/negrita\*\*negrita/);
    expect(chunkText(longLine, 4000)[0]?.endsWith('**')).toBe(false);
  });

  it('un corte en salto de línea no toca un ** suelto de esa línea', () => {
    const text = `${'x '.repeat(1500)}\nlinea con ** suelto\n${'y '.repeat(1500)}`;
    const parts = chunkText(text, 4000, { marks: true });
    expect(parts).toEqual(chunkText(text, 4000));
  });

  it('send() con formato marks manda las dos partes en negrita (HTML)', async () => {
    await channel().send(out(longLine, 'marks'));
    expect(state.sent.length).toBe(2);
    for (const s of state.sent) {
      expect(s.parseMode).toBe('HTML');
      expect(s.text).toContain('<b>negrita');
    }
  });
});
