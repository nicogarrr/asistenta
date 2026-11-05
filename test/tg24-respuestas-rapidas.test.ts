import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Respuestas rápidas: una respuesta que acaba en pregunta de sí o no lleva «Sí» / «No»;
 * un toque entra como si el dueño lo hubiera escrito. grammY falseado.
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
  isYesNoQuestion,
  quickReplyButtons,
  quickReplyText,
} from '../src/channels/telegram-respuestas.js';
import type { Inbound } from '../src/channels/types.js';

afterEach(() => {
  harness.listeners.clear();
  harness.state.markups = [];
});

describe('qué respuestas llevan «Sí» / «No»', () => {
  it.each([
    'Hecho. ¿Quieres que te lo apunte?',
    '¿Lo envío ya? 🙂',
    'He encontrado tres vuelos.\n\n¿Reservo el de las 7:40?',
    '**¿Te parece bien?**',
    'Vale. ¿Apago la tele?',
    'Listo, ¿te aviso mañana a las 9?',
  ])('sí: %s', (text) => {
    expect(isYesNoQuestion(text)).toBe(true);
  });

  it.each([
    '¿A qué hora te lo recuerdo?',
    '¿Lo envío hoy o mañana?',
    '¿Cuál prefieres?',
    'Hecho, te lo he apuntado.',
    '¿Qué tal ha ido la entrevista?',
    '¿Quieres el rojo, el azul o el verde?',
    '¿Dónde lo guardo?',
    '¿Quieres que lo apunte?\nTambién puedo ponerlo en el calendario.',
    '',
  ])('no: %s', (text) => {
    expect(isYesNoQuestion(text)).toBe(false);
  });

  it('los botones son «Sí» y «No» y caben en callback_data', () => {
    const buttons = quickReplyButtons('¿Lo borro?');
    expect(buttons?.map((b) => b.label)).toEqual(['Sí', 'No']);
    for (const b of buttons ?? []) expect(Buffer.byteLength(b.action)).toBeLessThanOrEqual(64);
    expect(quickReplyButtons('¿A qué hora?')).toBeUndefined();
    expect(quickReplyText('si')).toBe('Sí');
    expect(quickReplyText('toString')).toBeNull();
  });

  it('la respuesta del asistente los lleva cuando no se recortó', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/: quickReplyButtons\(short\.text\)/);
  });
});

async function setup() {
  const got: Inbound[] = [];
  const answers: Array<{ text?: string } | undefined> = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  const press = (data: string, from = 7) =>
    harness.listeners.get('callback_query:data')?.({
      callbackQuery: { data, message: { message_id: 80, chat: { id: 42, type: 'private' } } },
      from: { id: from, first_name: 'Nico' },
      answerCallbackQuery: async (a?: { text?: string }) => void answers.push(a),
    });
  return { got, answers, channel, press };
}

describe('tocar «Sí» o «No»', () => {
  it('entra como mensaje del dueño en el hilo de esa respuesta y deja «✓ Sí»', async () => {
    const { got, answers, channel, press } = await setup();
    await press('qr:si');
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe('Sí');
    expect(got[0]?.userId).toBe('7');
    expect(got[0]?.replyToMessageId).toBe('80');
    expect(answers[0]?.text).toBe('Sí');
    await vi.waitFor(() => expect(harness.state.markups).toHaveLength(1));
    expect(JSON.stringify(harness.state.markups[0])).toContain('✓ Sí');
    await channel.stop();
  });

  it('el botón «✓ …» que queda no vuelve a contestar', async () => {
    const { got, answers, channel, press } = await setup();
    await press('qr:hecho');
    expect(got).toEqual([]);
    expect(answers[0]?.text).toBe('Ya está contestado.');
    await channel.stop();
  });

  it('alguien que no es el dueño no contesta por él', async () => {
    const { got, channel, press } = await setup();
    await press('qr:no', 99);
    expect(got).toEqual([]);
    await channel.stop();
  });
});
