import { readFileSync } from 'node:fs';
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

import { TelegramChannel, tooBigForBotDownload } from '../src/channels/telegram.js';
import type { Inbound } from '../src/channels/types.js';

async function receive(message: Record<string, unknown>): Promise<Inbound> {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  await harness.listeners.get('message')?.({
    message: { message_id: 5, date: 0, chat: { id: 42, type: 'private' }, ...message },
    from: { id: 7 },
    chat: { id: 42, type: 'private' },
    me: { id: 1, username: 'bot' },
    reply: async () => {},
  });
  await channel.stop?.();
  expect(got).toHaveLength(1);
  return got[0] as Inbound;
}

afterEach(() => harness.listeners.clear());

describe('archivo reenviado de más de 20 MB', () => {
  it('el documento lleva el tamaño que declara Telegram', async () => {
    const inbound = await receive({
      document: { file_id: 'd', file_unique_id: 'u', file_name: 'a.pdf', file_size: 25_000_000 },
    });
    expect(inbound.documentSizeBytes).toBe(25_000_000);
  });

  it('la nota de voz lleva su tamaño', async () => {
    const inbound = await receive({
      voice: { file_id: 'v', file_unique_id: 'u', duration: 3000, file_size: 31_000_000 },
    });
    expect(inbound.audioSizeBytes).toBe(31_000_000);
  });

  it('dice que pasa del límite de 20 MB de los bots', () => {
    expect(tooBigForBotDownload(25_000_000)).toBe(
      'Pesa 25 MB y pasa de 20 MB, el límite de descarga de los bots de Telegram.',
    );
    expect(tooBigForBotDownload(20_000_000)).toBeUndefined();
    expect(tooBigForBotDownload(undefined)).toBeUndefined();
  });

  it('cli.ts usa la frase del límite en las notas de archivo', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli.match(/tooBigForBotDownload\(inbound\.documentSizeBytes\)/g)).toHaveLength(3);
    expect(cli).toContain('tooBigForBotDownload(inbound.audioSizeBytes)');
  });
});
