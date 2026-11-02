/**
 * Un álbum (varias fotos de una vez) llega de Telegram como un mensaje por foto con el
 * mismo media_group_id. Antes cada foto era un turno: «¿cuál te gusta más?» con tres fotos
 * recibía tres respuestas sueltas (y las fotos sin texto, «¿qué hago con esta foto?»).
 * Ahora es un solo turno con todas las fotos. Bot API falsa, relojes falsos.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { downloadAlbumPhotos } from '../src/cli.js';

async function open(chat: { id: number; type: string } = { id: 42, type: 'private' }) {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  let id = 10;
  const send = async (message: Record<string, unknown>) => {
    id += 1;
    await harness.listeners.get('message')?.({
      message: { message_id: id, date: 0, chat, ...message },
      from: { id: 7 },
      chat,
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
  };
  return { got, send, channel };
}

const photo = (fileId: string, extra: Record<string, unknown> = {}) => ({
  photo: [{ file_id: fileId, file_unique_id: fileId, width: 1, height: 1 }],
  ...extra,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  harness.listeners.clear();
});

describe('álbum de fotos', () => {
  it('las fotos de un álbum llegan juntas en un solo turno, con su texto', async () => {
    const { got, send } = await open();
    await send(photo('a', { media_group_id: 'g1', caption: '¿cuál te gusta más?' }));
    await send(photo('b', { media_group_id: 'g1' }));
    await send(photo('c', { media_group_id: 'g1' }));
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toBe('¿cuál te gusta más?');
    expect(got[0]?.photoFileId).toBe('a');
    expect(got[0]?.albumPhotoFileIds).toEqual(['b', 'c']);
  });

  it('el texto puesto en otra foto del álbum no se pierde', async () => {
    const { got, send } = await open();
    await send(photo('a', { media_group_id: 'g2' }));
    await send(photo('b', { media_group_id: 'g2', caption: 'compáralas' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.text)).toEqual(['compáralas']);
  });

  it('dos álbumes distintos son dos turnos; una foto suelta va como siempre', async () => {
    const { got, send } = await open();
    await send(photo('s'));
    expect(got.map((i) => i.photoFileId)).toEqual(['s']);
    await send(photo('a', { media_group_id: 'g3' }));
    await send(photo('x', { media_group_id: 'g4' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got.map((i) => i.photoFileId)).toEqual(['s', 'a', 'x']);
    expect(got[1]?.albumPhotoFileIds).toBeUndefined();
  });

  it('en un grupo, las fotos del álbum sin mención se unen a la que sí la lleva', async () => {
    const { got, send } = await open({ id: -42, type: 'supergroup' });
    await send(photo('a', { media_group_id: 'g5', caption: '@bot mira' }));
    await send(photo('b', { media_group_id: 'g5' }));
    await send(photo('z', { media_group_id: 'g6' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(got).toHaveLength(1);
    expect(got[0]?.albumPhotoFileIds).toEqual(['b']);
  });

  it('un álbum retenido sale al parar el canal', async () => {
    const { got, send, channel } = await open();
    await send(photo('a', { media_group_id: 'g7' }));
    await channel.stop?.();
    expect(got.map((i) => i.photoFileId)).toEqual(['a']);
  });

  it('el turno descarga cada foto más; una que falla se cuenta y no tumba las demás', async () => {
    const r = await downloadAlbumPhotos(['b', 'c', 'd'], async (id) => {
      if (id === 'c') throw new Error('red');
      return id === 'd' ? null : Buffer.from(id);
    });
    expect(r.photos.map((p) => p.id)).toEqual(['b']);
    expect(r.missing).toBe(2);
  });

  it('el turno añade las fotos del álbum a las imágenes que ve el modelo', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain('downloadAlbumPhotos(inbound.albumPhotoFileIds');
  });
});
