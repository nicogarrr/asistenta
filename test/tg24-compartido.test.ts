import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
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
  return { listeners, FakeBot, Plain };
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
  sharedContactText,
  sharedPollText,
  stickerText,
} from '../src/channels/telegram-compartido.js';
import type { Inbound } from '../src/channels/types.js';

async function receive(message: Record<string, unknown>, chatType = 'private') {
  const got: Inbound[] = [];
  const replies: string[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  await harness.listeners.get('message')?.({
    message: { message_id: 5, date: 0, chat: { id: 42, type: chatType }, ...message },
    from: { id: 7 },
    chat: { id: 42, type: chatType },
    me: { id: 1, username: 'bot' },
    reply: async (text: string) => void replies.push(text),
  });
  await channel.stop?.();
  return { got, replies };
}

afterEach(() => harness.listeners.clear());

describe('contactos, encuestas y stickers llegan al asistente como texto', () => {
  it('un contacto compartido llega con nombre y teléfono, sin el «aún no sé leer»', async () => {
    const { got, replies } = await receive({
      contact: { phone_number: '+34600111222', first_name: 'Ana', last_name: 'López' },
    });
    expect(replies).toEqual([]);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe('[Contacto compartido: «Ana López» · +34600111222]');
  });

  it('la vCard aporta el correo y la empresa', () => {
    const vcard =
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ana López\r\nORG:Clínica Dental;Recepción\r\n' +
      'item1.EMAIL;type=INTERNET:ana@clinica.es\r\nEMAIL:no es un correo\r\nEND:VCARD';
    expect(sharedContactText({ contact: { phone_number: '600', first_name: 'Ana', vcard } })).toBe(
      '[Contacto compartido: «Ana» · 600 · ana@clinica.es · (Clínica Dental Recepción)]',
    );
  });

  it('un contacto sin nombre ni teléfono no se inventa nada', () => {
    expect(sharedContactText({ contact: { first_name: ' ' } })).toBeNull();
    expect(sharedContactText({ text: 'hola' })).toBeNull();
  });

  it('los corchetes de un nombre no rompen la marca', () => {
    expect(sharedContactText({ contact: { phone_number: '1', first_name: 'Ana [jefa]' } })).toBe(
      '[Contacto compartido: «Ana jefa» · 1]',
    );
  });

  it('una encuesta reenviada llega con la pregunta y las opciones numeradas', async () => {
    const { got, replies } = await receive({
      forward_origin: { type: 'user', sender_user: { first_name: 'Marta' } },
      poll: {
        question: '¿Dónde cenamos el viernes?',
        options: [
          { text: 'Sushi', voter_count: 2 },
          { text: 'Pizza', voter_count: 0 },
        ],
        allows_multiple_answers: true,
        type: 'regular',
      },
    });
    expect(replies).toEqual([]);
    expect(got[0]?.text).toMatch(/^\[Mensaje reenviado/);
    expect(got[0]?.text).toContain(
      '[Encuesta compartida, se puede marcar más de una: «¿Dónde cenamos el viernes?» Opciones: 1) Sushi (2); 2) Pizza (0)]',
    );
  });

  it('un cuestionario sin votos no enseña recuentos', () => {
    expect(
      sharedPollText({
        poll: { question: '2+2', options: [{ text: '4' }, { text: '5' }], type: 'quiz' },
      }),
    ).toBe('[Cuestionario compartido: «2+2» Opciones: 1) 4; 2) 5]');
  });

  it('un sticker 👍 llega como su emoji', async () => {
    const { got, replies } = await receive({ sticker: { file_id: 's', emoji: '👍' } });
    expect(replies).toEqual([]);
    expect(got[0]?.text).toBe('[Sticker 👍]');
  });

  it('un sticker en un grupo sin mención sigue ignorado', async () => {
    const { got, replies } = await receive({ sticker: { file_id: 's', emoji: '👍' } }, 'group');
    expect(got).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('un sticker sin emoji no es texto', () => {
    expect(stickerText({ sticker: { file_id: 's' } })).toBeNull();
  });
});
