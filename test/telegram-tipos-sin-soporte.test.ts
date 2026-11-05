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
import type { Inbound } from '../src/channels/types.js';

async function receive(message: Record<string, unknown>) {
  const got: Inbound[] = [];
  const replies: string[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  await harness.listeners.get('message')?.({
    message: { message_id: 5, date: 0, chat: { id: 42, type: 'private' }, ...message },
    from: { id: 7 },
    chat: { id: 42, type: 'private' },
    me: { id: 1, username: 'bot' },
    reply: async (text: string) => void replies.push(text),
  });
  await channel.stop?.();
  return { got, replies };
}

afterEach(() => harness.listeners.clear());

describe('mensajes que Asistenta aún no sabe leer', () => {
  it('un sticker recibe un aviso en vez de silencio', async () => {
    const { got, replies } = await receive({ sticker: { file_id: 's', emoji: '👍' } });
    expect(got).toHaveLength(0);
    expect(replies).toEqual(['Aún no sé ver stickers. Si quieres algo, escríbemelo.']);
  });

  it('un contacto también avisa', async () => {
    const contact = await receive({ contact: { phone_number: '600', first_name: 'Ana' } });
    expect(contact.replies[0]).toMatch(/contactos/);
  });

  it('un vídeo sin texto avisa', async () => {
    const { got, replies } = await receive({ video: { file_id: 'v', duration: 3 } });
    expect(got).toHaveLength(0);
    expect(replies[0]).toMatch(/vídeos/);
  });

  it('un vídeo con texto sigue llegando al asistente y avisa de que el vídeo no se ve', async () => {
    const { got, replies } = await receive({ video: { file_id: 'v' }, caption: 'mira esto' });
    expect(got[0]?.text).toBe('mira esto');
    expect(replies).toEqual(['Aún no puedo ver vídeos ni GIF: te contesto solo al texto.']);
  });

  it('un GIF con texto también avisa, y el texto llega igual', async () => {
    const { got, replies } = await receive({ animation: { file_id: 'g' }, caption: 'jaja' });
    expect(got[0]?.text).toBe('jaja');
    expect(replies).toEqual(['Aún no puedo ver vídeos ni GIF: te contesto solo al texto.']);
  });

  it('una foto con texto no recibe ese aviso', async () => {
    const { got, replies } = await receive({
      photo: [{ file_id: 'p', width: 1, height: 1 }],
      caption: 'mira',
    });
    expect(got[0]?.photoFileId).toBe('p');
    expect(replies).toHaveLength(0);
  });

  it('un dado y una historia reenviada también avisan', async () => {
    const dice = await receive({ dice: { emoji: '🎲', value: 4 } });
    expect(dice.got).toHaveLength(0);
    expect(dice.replies).toEqual(['Aún no juego a los dados. Si quieres algo, escríbemelo.']);
    const story = await receive({ story: { chat: { id: 3, type: 'channel' }, id: 9 } });
    expect(story.got).toHaveLength(0);
    expect(story.replies).toEqual([
      'Aún no puedo ver historias. Cuéntame qué hay o mándame una captura.',
    ]);
  });

  it('un mensaje de servicio de grupo no recibe respuesta', async () => {
    const { got, replies } = await receive({ new_chat_members: [{ id: 9 }] });
    expect(got).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});
