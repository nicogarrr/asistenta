import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Respuestas rápidas con opciones: si la respuesta acaba en «¿A o B?» («¿Hoy o mañana?»,
 * «¿Te lo mando por correo o por WhatsApp?»), trae un botón por opción y un toque
 * equivale a escribirla. Antes solo había «Sí» / «No» y aquí no salía nada.
 */
const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const state = { markups: [] as unknown[] };
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
      editMessageReplyMarkup: async (_c: number, _m: number, extra: unknown) => {
        state.markups.push(extra);
        return true;
      },
    };
    on(event: string, fn: (ctx: unknown) => unknown): void {
      listeners.set(event, fn);
    }
    catch(): void {}
    start(): Promise<void> {
      return new Promise(() => {});
    }
    async stop(): Promise<void> {}
  }
  class Plain {}
  return { listeners, state, FakeBot, Plain };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.Plain,
  HttpError: harness.Plain,
  InlineKeyboard: harness.Plain,
  InputFile: harness.Plain,
}));

import { TelegramChannel } from '../src/channels/telegram.js';
import {
  choiceOptions,
  choiceText,
  isYesNoQuestion,
  quickReplyButtons,
} from '../src/channels/telegram-respuestas.js';
import type { Inbound } from '../src/channels/types.js';

afterEach(() => {
  harness.listeners.clear();
  harness.state.markups = [];
});

describe('qué preguntas traen un botón por opción', () => {
  it.each([
    ['¿Hoy o mañana?', ['Hoy', 'Mañana']],
    ['Vale. ¿Te lo mando por correo o por WhatsApp?', ['Por correo', 'Por WhatsApp']],
    ['¿Quieres el rojo, el azul o el verde?', ['El rojo', 'El azul', 'El verde']],
    ['¿Cuál prefieres, el rojo o el azul?', ['El rojo', 'El azul']],
    ['¿Prefieres el de las 8 o el de las 10?', ['El de las 8', 'El de las 10']],
    ['¿Hoy, mañana o el viernes?', ['Hoy', 'Mañana', 'El viernes']],
    ['¿Lo quieres en PDF o en Word?', ['En PDF', 'En Word']],
    [
      'Dos pisos. ¿Cuál te gusta más: el de Chamberí o el de Lavapiés?',
      ['El de Chamberí', 'El de Lavapiés'],
    ],
    ['¿Qué te viene mejor, 8 o 10?', ['8', '10']],
    ['¿Lo envío hoy o mañana? 🙂', ['Hoy', 'Mañana']],
    ['¿Pongo Netflix u HBO?', ['Netflix', 'HBO']],
  ])('%s', (text, options) => {
    expect(choiceOptions(text)).toEqual(options);
  });

  it.each([
    '¿Lo envío o no?',
    '¿Te mando el resumen ahora o prefieres esperar a mañana?',
    '¿Quieres que lo busque o prefieres hacerlo tú?',
    '¿Sigo o lo dejamos aquí?',
    '¿A qué hora te lo recuerdo?',
    '¿Esto o esto?',
    '¿Hoy o mañana?\nTambién puedo dejarlo para el lunes.',
    'Hecho: elegí el rojo o el azul.',
    '',
  ])('no: %s', (text) => {
    expect(choiceOptions(text)).toBeNull();
  });

  it('los botones de opción caben en callback_data y «Sí»/«No» sigue igual', () => {
    const buttons = quickReplyButtons('¿Te lo mando por correo o por WhatsApp?');
    expect(buttons).toEqual([
      { label: 'Por correo', action: 'qr:o1' },
      { label: 'Por WhatsApp', action: 'qr:o2' },
    ]);
    for (const b of buttons ?? []) expect(Buffer.byteLength(b.action)).toBeLessThanOrEqual(64);
    expect(isYesNoQuestion('¿Lo borro?')).toBe(true);
    expect(quickReplyButtons('¿Lo borro?')?.map((b) => b.label)).toEqual(['Sí', 'No']);
  });

  it('el texto de un botón de opción es su etiqueta en el teclado del mensaje', () => {
    const markup = {
      inline_keyboard: [
        [
          { text: 'Hoy', callback_data: 'qr:o1' },
          { text: 'Mañana', callback_data: 'qr:o2' },
        ],
      ],
    };
    expect(choiceText('o2', markup)).toBe('Mañana');
    expect(choiceText('o3', markup)).toBeNull();
    expect(choiceText('si', markup)).toBeNull();
    expect(choiceText('o1', undefined)).toBeNull();
  });
});

describe('tocar una opción', () => {
  it('entra como si el dueño la escribiera, en el hilo, y deja «✓ Mañana»', async () => {
    const got: Inbound[] = [];
    const answers: Array<{ text?: string } | undefined> = [];
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
    await harness.listeners.get('callback_query:data')?.({
      callbackQuery: {
        data: 'qr:o2',
        message: {
          message_id: 80,
          chat: { id: 42, type: 'private' },
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Hoy', callback_data: 'qr:o1' },
                { text: 'Mañana', callback_data: 'qr:o2' },
              ],
            ],
          },
        },
      },
      from: { id: 7, first_name: 'Nico' },
      answerCallbackQuery: async (a?: { text?: string }) => void answers.push(a),
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe('Mañana');
    expect(got[0]?.replyToMessageId).toBe('80');
    expect(answers[0]?.text).toBe('Mañana');
    await vi.waitFor(() => expect(harness.state.markups).toHaveLength(1));
    expect(JSON.stringify(harness.state.markups[0])).toContain('✓ Mañana');
    await channel.stop();
  });
});
