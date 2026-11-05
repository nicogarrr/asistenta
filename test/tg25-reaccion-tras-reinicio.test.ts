import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Una reacción (👎, 🤔) a una respuesta de antes de reiniciar Asistenta también la
 * revisa: las respuestas recientes se guardan en disco y se leen al arrancar. Antes
 * vivían solo en memoria y tras un reinicio la reacción no hacía nada. grammY falseado.
 */
const harness = vi.hoisted(() => {
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const state = { startOptions: [] as unknown[], nextId: 100 };
  class FakeBot {
    api = {
      config: { use: () => {} },
      setMyCommands: async () => true,
      getMe: async () => ({ id: 1, username: 'bot' }),
      sendMessage: async () => {
        state.nextId += 1;
        return { message_id: state.nextId };
      },
    };
    on(event: string, fn: (ctx: unknown) => unknown): void {
      listeners.set(event, fn);
    }
    catch(): void {}
    start(options?: unknown): Promise<void> {
      state.startOptions.push(options);
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
import { SENT_TEXT_KEEP_CHARS, SentTexts } from '../src/channels/telegram-enviados.js';
import type { Inbound } from '../src/channels/types.js';

const emoji = (e: string) => ({ type: 'emoji', emoji: e });
const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg25-enviados-'));
  dirs.push(dir);
  return join(dir, 'state', 'telegram-respuestas-recientes.json');
}

async function open(file: string) {
  const got: Inbound[] = [];
  const channel = new TelegramChannel({ token: 't', allowedUserIds: [7], sentTextsFile: file });
  await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
  const react = async (messageId: number, e: string) =>
    harness.listeners.get('message_reaction')?.({
      messageReaction: {
        chat: { id: 42, type: 'private' },
        message_id: messageId,
        user: { id: 7, first_name: 'Nico' },
        date: 1_700_000_000,
        old_reaction: [],
        new_reaction: [emoji(e)],
      },
    });
  return { got, channel, react };
}

afterEach(() => {
  harness.listeners.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('reacciones tras reiniciar', () => {
  it('un 👎 a una respuesta de antes del reinicio llega citándola, en su hilo', async () => {
    const file = tmpFile();
    const first = await open(file);
    const id = await first.channel.send({
      channel: 'telegram',
      account: 'main',
      chatId: '42',
      threadId: '9',
      text: 'El vuelo a Roma sale a las 7:40 desde Barajas.',
    });
    await first.channel.stop();
    harness.listeners.clear();

    const second = await open(file);
    await second.react(Number(id), '👎');
    expect(second.got).toHaveLength(1);
    expect(second.got[0]?.text).toContain('«El vuelo a Roma sale a las 7:40');
    expect(second.got[0]?.threadId).toBe('9');
    expect(second.got[0]?.replyToMessageId).toBe(String(id));
    await second.channel.stop();
  });

  it('sin fichero, como antes: solo en memoria', async () => {
    const texts = new SentTexts(3);
    texts.set('42:1', { text: 'hola' });
    await texts.flush();
    expect(texts.get('42:1')?.text).toBe('hola');
  });
});

describe('el fichero de respuestas recientes', () => {
  it('guarda solo las últimas y recortadas, y escribe agrupado', async () => {
    const file = tmpFile();
    const texts = new SentTexts(2, file, 60_000);
    texts.set('42:1', { text: 'uno' });
    texts.set('42:2', { text: 'x'.repeat(5_000), threadId: '3' });
    texts.set('42:3', { text: 'tres' });
    await texts.flush();
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<[string, { text: string }]>;
    expect(rows.map((r) => r[0])).toEqual(['42:2', '42:3']);
    expect(rows[0]?.[1].text.length).toBe(SENT_TEXT_KEEP_CHARS);
    const again = new SentTexts(2, file);
    expect(again.get('42:2')?.threadId).toBe('3');
    expect(again.get('42:1')).toBeUndefined();
  });

  it('un fichero roto o raro no impide arrancar', () => {
    const file = tmpFile();
    const texts = new SentTexts(5, file);
    expect(texts.size).toBe(0);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{roto');
    expect(new SentTexts(5, file).size).toBe(0);
    writeFileSync(file, JSON.stringify([['42:1', { text: 'ok' }], ['x'], [3, {}], ['42:2', {}]]));
    const loaded = new SentTexts(5, file);
    expect(loaded.size).toBe(1);
    expect(loaded.get('42:1')?.text).toBe('ok');
  });

  it('el asistente lo guarda en su carpeta de estado', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain("sentTextsFile: join(paths.state, 'telegram-respuestas-recientes.json')");
  });
});
