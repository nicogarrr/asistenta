import { afterEach, describe, expect, it, vi } from 'vitest';

// Con el reloj del PC adelantado más de 2 min, todas las órdenes a la tele por
// Telegram parecían «tardías» y no se hacían. La edad se mide con la hora de
// Telegram (lo que trae el sondeo), no con el reloj del PC.
const harness = vi.hoisted(() => {
  type Transformer = (
    prev: (method: string, payload: unknown) => Promise<unknown>,
    method: string,
    payload: unknown,
  ) => Promise<unknown>;
  const listeners = new Map<string, (ctx: unknown) => unknown>();
  const transformers: Transformer[] = [];
  class FakeBot {
    api = {
      config: { use: (t: Transformer) => void transformers.push(t) },
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
  return { listeners, transformers, FakeBot, Plain };
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
import { staleTvOrderNotice } from '../src/tv/stale-order.js';
import { TelegramClock } from '../src/tv/telegram-clock.js';

afterEach(() => {
  harness.listeners.clear();
  harness.transformers.length = 0;
  vi.useRealTimers();
});

const SERVER = Date.parse('2026-10-31T10:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);
const msg = (id: number, dateMs: number) => ({ update_id: id, message: { date: sec(dateMs) } });

describe('reloj de Telegram', () => {
  it('PC 5 min adelantado: una orden recién enviada no es tardía', () => {
    const skew = 5 * 60_000;
    const c = new TelegramClock();
    c.observe([], 100, SERVER + skew - 25_000); // primer sondeo, cola vacía
    const sent = SERVER;
    const got = SERVER + skew + 400; // llega al PC 0,4 s después
    c.observe([msg(1, sent)], 100, got);
    // Con el reloj del PC (lo de antes) parecía de hace 5 min.
    expect(staleTvOrderNotice(new Date(sent).toISOString(), got)).not.toBeNull();
    expect(staleTvOrderNotice(new Date(c.sentAtMs(sec(sent), 1)).toISOString(), got)).toBeNull();
    // Y la siguiente también, sin depender de su propio lote.
    const sent2 = SERVER + 60_000;
    expect(
      staleTvOrderNotice(new Date(c.sentAtMs(sec(sent2))).toISOString(), sent2 + skew + 300),
    ).toBeNull();
  });

  it('tras reconectar, una orden de hace 10 min sigue siendo vieja (y dice 10, no 15)', () => {
    const skew = 5 * 60_000;
    const c = new TelegramClock();
    c.observe([], 100, SERVER + skew);
    c.observe([msg(1, SERVER + 20_000)], 100, SERVER + skew + 20_500);
    c.reset(); // corte y reconexión: el primer lote es cola vieja
    const now = SERVER + 3_600_000;
    const old = now - 10 * 60_000;
    c.observe([msg(2, old)], 100, now + skew);
    const n = staleTvOrderNotice(new Date(c.sentAtMs(sec(old), 2)).toISOString(), now + skew);
    expect(n).toMatch(/hace 10 min/);
  });

  it('PC atrasado: una orden vieja no pasa como nueva', () => {
    const skew = -5 * 60_000;
    const c = new TelegramClock();
    c.observe([], 100, SERVER + skew);
    c.observe([msg(1, SERVER + 10_000)], 100, SERVER + skew + 10_300);
    c.reset();
    const now = SERVER + 600_000;
    const old = now - 4 * 60_000;
    expect(staleTvOrderNotice(new Date(old).toISOString(), now + skew)).toBeNull(); // lo de antes
    expect(staleTvOrderNotice(new Date(c.sentAtMs(sec(old), 9)).toISOString(), now + skew)).toMatch(
      /hace 4 min/,
    );
  });

  it('el primer lote tras conectar no sirve para medir; sin medida, el reloj del PC', () => {
    const c = new TelegramClock();
    c.observe([msg(1, SERVER - 30 * 60_000)], 100, SERVER);
    expect(c.offsetMs()).toBe(0);
    // Un lote lleno (100) no vacía la cola: el siguiente tampoco es «en vivo».
    const d = new TelegramClock();
    const full = Array.from({ length: 100 }, (_, i) => msg(10 + i, SERVER - 20 * 60_000));
    d.observe(full, 100, SERVER);
    d.observe([msg(200, SERVER - 19 * 60_000)], 100, SERVER + 1_000);
    expect(d.offsetMs()).toBe(0);
  });
});

describe('Telegram con el PC adelantado', () => {
  it('«pausa la tele» recién enviada llega con sentAt en hora y no se salta', async () => {
    const skew = 3 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SERVER + skew);
    const got: Inbound[] = [];
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
    const poll = async (result: unknown[]) => {
      for (const t of harness.transformers) {
        await t(async () => ({ ok: true, result }), 'getUpdates', { limit: 100 });
      }
    };
    await poll([]);
    vi.setSystemTime(SERVER + skew + 15_000);
    const update = {
      update_id: 50,
      message: {
        message_id: 5,
        date: sec(SERVER + 14_800),
        chat: { id: 42, type: 'private' },
        text: 'pausa la tele',
      },
    };
    await poll([update]);
    await harness.listeners.get('message')?.({
      update,
      message: update.message,
      from: { id: 7 },
      chat: { id: 42, type: 'private' },
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
    await channel.stop?.();
    const inbound = got[0];
    expect(inbound?.sentAt).toBeDefined();
    expect(staleTvOrderNotice(inbound?.sentAt, inbound?.receivedAt ?? '')).toBeNull();
  });
});
