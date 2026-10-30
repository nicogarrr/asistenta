import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E2E del troceo de Telegram: una respuesta larga del agente (con negritas, enlaces,
 * código y «<»/«&») pasa por TelegramChannel.send contra una Bot API falsa. Cada
 * mensaje debe caber en el límite de Telegram (4096 caracteres DESPUÉS de interpretar
 * el HTML), llevar el HTML equilibrado (ninguna etiqueta cortada) y, juntos, decir lo
 * mismo que la respuesta entera. Sin token ni red.
 */
const harness = vi.hoisted(() => {
  const state = {
    sent: [] as Array<{ text: string; parseMode?: string; markup?: unknown; reply?: number }>,
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
      sendMessage: async (
        _chatId: number,
        text: string,
        options?: { parse_mode?: string; reply_markup?: unknown; reply_to_message_id?: number },
      ) => {
        if (options?.parse_mode && state.htmlErrors.length) {
          throw new FakeGrammyError(400, state.htmlErrors.shift() as string);
        }
        state.sent.push({
          text,
          parseMode: options?.parse_mode,
          markup: options?.reply_markup,
          reply: options?.reply_to_message_id,
        });
        return { message_id: state.sent.length };
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

import { cleanForTelegram } from '../src/channels/formatters.js';
import { TelegramChannel } from '../src/channels/telegram.js';

const LIMIT = 4096;
const state = harness.state;
const channel = () => new TelegramChannel({ token: 't', allowedUserIds: [7] });

/** Lo que Telegram cuenta: el texto tras interpretar las entidades HTML. */
const visible = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** Abre/cierra en orden correcto: ninguna etiqueta queda partida entre mensajes. */
function balanced(html: string): boolean {
  if (/<[^>]*$/.test(html)) return false;
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2] as string);
  }
  return stack.length === 0;
}

const paragraph = (i: number) =>
  `**Punto ${i}.** Revisé el pedido <ref-${i}> de Ana & Co: precio **1.${i}00 €**, ` +
  `detalles en [la tienda](https://tienda.example/p/${i}?a=1&b=2). ` +
  'Texto de relleno para que la respuesta sea larga de verdad y obligue a trocear. '.repeat(3);

const longAnswer = (n: number) =>
  Array.from({ length: n }, (_, i) => paragraph(i + 1)).join('\n\n');

/** Tiempo real (no lo tocan los relojes falsos) que tardó el último send. */
let lastSendWallMs = 0;

// El canal espacia los mensajes ~1,1 s (límite de Telegram). Con relojes reales cada caso
// dormía de verdad 3–4 s y el fichero entero ~24 s: bajo carga, con muchas lanes a la vez,
// era de los que se pasaban de tiempo. Lo que se prueba aquí es el troceo, no el ritmo:
// los temporizadores van con reloj falso y se avanzan hasta vaciar la cola.
const send = async (text: string, extra: Record<string, unknown> = {}) => {
  const t0 = performance.now();
  const p = channel().send({
    channel: 'telegram',
    account: 'a',
    chatId: '7',
    text: cleanForTelegram(text, { keepMarks: true }),
    format: 'marks',
    ...extra,
  });
  await vi.runAllTimersAsync();
  await p;
  lastSendWallMs = performance.now() - t0;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  state.sent.length = 0;
  state.htmlErrors.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('e2e troceo de respuestas largas en Telegram', () => {
  it('cada trozo cabe en 4096, va en HTML equilibrado y no se pierde ni repite nada', async () => {
    const answer = longAnswer(40);
    await send(answer);
    expect(state.sent.length).toBeGreaterThan(1);
    // Sin esperas reales entre trozos (antes ~1,1 s por trozo).
    expect(lastSendWallMs).toBeLessThan(1000);
    for (const m of state.sent) {
      expect(m.parseMode).toBe('HTML');
      expect(Array.from(visible(m.text)).length).toBeLessThanOrEqual(LIMIT);
      expect(balanced(m.text), m.text.slice(-200)).toBe(true);
      expect(m.text).not.toContain('**');
    }
    // Un enlace <a> se vuelve a escribir como [texto](url) para comparar también la URL.
    const joined = state.sent
      .map((m) => m.text)
      .join('\n')
      .replace(/<a href="([^"]+)">(.*?)<\/a>/g, '[$2]($1)');
    const whole = words(visible(joined));
    const expected = words(answer.replace(/\*\*/g, ''));
    expect(whole).toEqual(expected);
  });

  it('ninguna URL se parte entre dos mensajes', async () => {
    await send(longAnswer(40));
    const urls = state.sent.flatMap((m) => [
      ...m.text.matchAll(
        /<a href="https:\/\/tienda\.example\/p\/(\d+)\?a=1&amp;b=2">la tienda<\/a>/g,
      ),
    ]);
    expect(urls.map((u) => Number(u[1]))).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('un bloque de código largo partido queda cerrado en cada mensaje', async () => {
    const code = Array.from(
      { length: 400 },
      (_, i) => `const x${i} = a < b && c > d; // línea ${i}`,
    );
    await send(`Aquí va el script:\n\n\`\`\`ts\n${code.join('\n')}\n\`\`\`\n\nFin.`);
    expect(state.sent.length).toBeGreaterThan(1);
    for (const m of state.sent) {
      expect(Array.from(visible(m.text)).length).toBeLessThanOrEqual(LIMIT);
      expect(balanced(m.text)).toBe(true);
      expect(m.text).not.toContain('```');
    }
    const lines = visible(state.sent.map((m) => m.text).join('\n')).split('\n');
    for (let i = 0; i < 400; i++)
      expect(lines.filter((l) => l.endsWith(`// línea ${i}`)).length).toBe(1);
  });

  it('una negrita larga que cruza el corte no deja asteriscos sueltos', async () => {
    const bold = `**${'palabra importante '.repeat(300)}**`;
    await send(`${'Intro corta. '.repeat(250)}${bold} y cierre.`);
    for (const m of state.sent) {
      expect(m.text).not.toContain('*');
      expect(balanced(m.text)).toBe(true);
      expect(Array.from(visible(m.text)).length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('los botones (aprobar/denegar) van solo en el primer trozo', async () => {
    await send(longAnswer(40), {
      buttons: [
        { label: 'Sí', action: 'approve:1' },
        { label: 'No', action: 'deny:1' },
      ],
    });
    expect(state.sent[0]?.markup).toBeDefined();
    for (const m of state.sent.slice(1)) expect(m.markup).toBeUndefined();
  });

  it('si Telegram rechaza el HTML de un trozo, ESE trozo sale en texto plano y los demás en HTML', async () => {
    const answer = longAnswer(40);
    // El primer envío con HTML falla una vez → reintento plano de ese trozo.
    state.htmlErrors.push("Bad Request: can't parse entities: unexpected end tag");
    await send(answer);
    expect(state.sent[0]?.parseMode).toBeUndefined();
    expect(state.sent[0]?.text).not.toContain('**');
    expect(state.sent[0]?.text).not.toContain('<b>');
    for (const m of state.sent.slice(1)) expect(m.parseMode).toBe('HTML');
    for (const m of state.sent)
      expect(Array.from(visible(m.text)).length).toBeLessThanOrEqual(LIMIT);
  });

  it('emojis y acentos: ningún trozo deja medio emoji (sin carácter de reemplazo)', async () => {
    await send(Array.from({ length: 900 }, (_, i) => `👍🏽 ítem ${i} ✅`).join(' '));
    for (const m of state.sent) {
      expect(m.text).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
      expect(Array.from(visible(m.text)).length).toBeLessThanOrEqual(LIMIT);
    }
  });
});
