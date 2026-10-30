import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Enlaces markdown `[texto](url)` del modelo: antes llegaban LITERALES a Telegram
 * («[la tienda](https://…)» con corchetes). Ahora son enlaces reales (<a>) solo para
 * http/https, con la URL escapada; el respaldo en texto plano los deja «texto (url)».
 * grammY falseado.
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

import { stripMarks, telegramHtml } from '../src/channels/formatters.js';
import { TelegramChannel } from '../src/channels/telegram.js';

const channel = () => new TelegramChannel({ token: 't', allowedUserIds: [7] });
const state = harness.state;
const out = (text: string, format?: 'marks') => ({
  channel: 'telegram',
  account: 'a',
  chatId: '7',
  text,
  format,
});

describe('enlaces markdown en telegramHtml', () => {
  it('[texto](url) → <a href> con el texto', () => {
    expect(telegramHtml('Mira [la tienda](https://tienda.es/x) ya')).toBe(
      'Mira <a href="https://tienda.es/x">la tienda</a> ya',
    );
  });

  it('la URL y el texto se escapan; una comilla corta la URL (nunca sale del href)', () => {
    expect(telegramHtml('[a <b> & c](https://x.es/?q=1&r=2)')).toBe(
      '<a href="https://x.es/?q=1&amp;r=2">a &lt;b&gt; &amp; c</a>',
    );
    expect(telegramHtml('[a](https://x.es/?r="2")')).toBe('[a](https://x.es/?r="2")');
  });

  it('negrita alrededor y dentro del enlace', () => {
    expect(telegramHtml('**[Ver](https://a.es)**')).toBe('<b><a href="https://a.es">Ver</a></b>');
    expect(telegramHtml('[**Ver**](https://a.es)')).toBe('<a href="https://a.es"><b>Ver</b></a>');
  });

  it('URL con paréntesis (Wikipedia) entera', () => {
    expect(telegramHtml('[wiki](https://es.wikipedia.org/wiki/A_(b)).')).toBe(
      '<a href="https://es.wikipedia.org/wiki/A_(b)">wiki</a>.',
    );
  });

  it('solo http/https: javascript: y tg: quedan literales', () => {
    expect(telegramHtml('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
    expect(telegramHtml('[x](tg://resolve?domain=a)')).toBe('[x](tg://resolve?domain=a)');
    expect(telegramHtml('[x](https://a.es/"onclick=1)')).not.toContain('onclick=1"');
  });

  it('dentro de `código` o de un bloque no se convierte', () => {
    expect(telegramHtml('`[a](https://a.es)`')).toBe('<code>[a](https://a.es)</code>');
    expect(telegramHtml('```\n[a](https://a.es)\n```')).toBe('<pre>[a](https://a.es)</pre>');
  });

  it('varios enlaces en una línea', () => {
    expect(telegramHtml('[a](https://a.es) y [b](http://b.es)')).toBe(
      '<a href="https://a.es">a</a> y <a href="http://b.es">b</a>',
    );
  });

  it('respaldo en texto plano: «texto (url)», sin corchetes', () => {
    expect(stripMarks('Mira **[la tienda](https://tienda.es/x)**')).toBe(
      'Mira la tienda (https://tienda.es/x)',
    );
  });
});

describe('enlaces markdown al enviar por Telegram', () => {
  beforeEach(() => {
    state.sent = [];
    state.htmlErrors = [];
  });

  it('sale como <a> con parse_mode HTML', async () => {
    await channel().send(out('Compra en [la tienda](https://tienda.es/p?a=1&b=2)', 'marks'));
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.parseMode).toBe('HTML');
    expect(state.sent[0]?.text).toContain(
      '<a href="https://tienda.es/p?a=1&amp;b=2">la tienda</a>',
    );
    expect(state.sent[0]?.text).not.toContain('](');
  });

  it('si Telegram rechaza el HTML, el texto plano lleva «texto (url)»', async () => {
    state.htmlErrors.push("Bad Request: can't parse entities");
    await channel().send(out('Compra en [la tienda](https://tienda.es/p)', 'marks'));
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]?.parseMode).toBeUndefined();
    expect(state.sent[0]?.text).toBe('Compra en la tienda (https://tienda.es/p)');
  });
});
