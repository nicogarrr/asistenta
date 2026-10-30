import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Negritas reales en Telegram: el texto sale como HTML escapado y, si Telegram lo
 * rechaza, el mismo trozo sale en texto plano. grammY falseado: sin token ni red.
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

import { cleanForTelegram, stripMarks, telegramHtml } from '../src/channels/formatters.js';
import { TelegramChannel } from '../src/channels/telegram.js';

const state = harness.state;
const channel = () => new TelegramChannel({ token: 't', allowedUserIds: [7] });
const out = (text: string, format?: 'marks') => ({
  channel: 'telegram',
  account: 'a',
  chatId: '7',
  text,
  format,
});

beforeEach(() => {
  state.sent.length = 0;
  state.htmlErrors.length = 0;
});

describe('cleanForTelegram keepMarks + telegramHtml', () => {
  it('un título y una **negrita** salen en <b>, el resto escapado', () => {
    const marked = cleanForTelegram('## Resumen\nPrecio **1.500 €** para <Ana> & Co', {
      keepMarks: true,
    });
    expect(marked).toBe('**Resumen**\nPrecio **1.500 €** para <Ana> & Co');
    expect(telegramHtml(marked)).toBe(
      '<b>Resumen</b>\nPrecio <b>1.500 €</b> para &lt;Ana&gt; &amp; Co',
    );
  });

  it('el código no se pone en negrita y va escapado; los bloques van en <pre>', () => {
    expect(telegramHtml('usa `a**b**<c>`')).toBe('usa <code>a**b**&lt;c&gt;</code>');
    expect(telegramHtml('```ts\nif (a < b && c) {}\n```')).toBe(
      '<pre><code class="language-ts">if (a &lt; b &amp;&amp; c) {}</code></pre>',
    );
    // Un trozo cortado con el bloque abierto se cierra igualmente.
    expect(telegramHtml('```\nx < 1')).toBe('<pre>x &lt; 1</pre>');
  });

  it('una etiqueta inyectada en el texto nunca llega como etiqueta', () => {
    const html = telegramHtml('<a href="https://evil">pulsa</a> <b>no</b>');
    expect(html).not.toMatch(/<a |<b>/);
    expect(html).toContain('&lt;a href=');
  });

  it('un ** suelto desaparece; sin keepMarks todo sigue como antes', () => {
    expect(telegramHtml('2 ** 3 y **abierta')).toBe('2  3 y abierta');
    expect(cleanForTelegram('## Hola\n**x** `y`')).toBe('Hola\nx y');
    expect(stripMarks('**Hola** `y`\n```\n**z**\n```')).toBe('Hola y\n```\n**z**\n```');
  });
});

describe('TelegramChannel.send con format marks', () => {
  it('envía HTML con parse_mode y negritas reales', async () => {
    await channel().send(out('**Hecho**: 3 < 4', 'marks'));
    expect(state.sent).toEqual([{ text: '<b>Hecho</b>: 3 &lt; 4', parseMode: 'HTML' }]);
  });

  it('si Telegram rechaza el HTML, el mismo texto sale en plano (sin marcas) y no se pierde', async () => {
    state.htmlErrors.push("Bad Request: can't parse entities: Unsupported start tag");
    const id = await channel().send(out('**Hecho**: listo', 'marks'));
    expect(id).toBe('1');
    expect(state.sent).toEqual([{ text: 'Hecho: listo', parseMode: undefined }]);
  });

  it('sin format, el texto sale tal cual y sin parse_mode (aprobaciones, avisos)', async () => {
    await channel().send(out('**literal** <x>'));
    expect(state.sent).toEqual([{ text: '**literal** <x>', parseMode: undefined }]);
  });
});
