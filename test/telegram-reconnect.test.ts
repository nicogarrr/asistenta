import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reconnect canary: a terminal polling failure must retry on its own with
 * backoff, say so once per outage, and stop retrying after stop() (audit,
 * line 120: "un fallo terminal deja el canal muerto hasta reinicio, sin
 * aviso al usuario").
 */
const harness = vi.hoisted(() => {
  const state = {
    startCalls: 0,
    failTimes: 0,
    onStart: undefined as undefined | ((me: { username: string; id: number }) => void),
    resolveStop: undefined as undefined | (() => void),
  };
  class FakeBot {
    readonly api = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => true,
      setMyCommands: async () => true,
      deleteMessage: async () => true,
      sendVideo: async () => ({ message_id: 2 }),
      sendDocument: async () => ({ message_id: 3 }),
    };
    on(): void {}
    catch(): void {}
    async start(opts?: { onStart?: (me: { username: string; id: number }) => void }): Promise<void> {
      state.startCalls++;
      state.onStart = opts?.onStart;
      if (state.failTimes > 0) {
        state.failTimes--;
        throw new Error('409 Conflict: terminated by other getUpdates request');
      }
      opts?.onStart?.({ username: 'bot', id: 1 });
      // Como el grammy real: la promesa queda pendiente mientras el polling
      // vive y solo resuelve cuando alguien para el bot.
      await new Promise<void>((resolve) => {
        state.resolveStop = resolve;
      });
    }
    async stop(): Promise<void> {
      state.resolveStop?.();
    }
  }
  class FakeGrammyError extends Error {
    readonly error_code = 0;
    readonly description = '';
  }
  class FakeHttpError extends Error {}
  class FakeInlineKeyboard {
    row(): this {
      return this;
    }
  }
  class FakeInputFile {
    readonly data: unknown;
    constructor(data: unknown) {
      this.data = data;
    }
  }
  return { state, FakeBot, FakeGrammyError, FakeHttpError, FakeInlineKeyboard, FakeInputFile };
});

vi.mock('grammy', () => ({
  Bot: harness.FakeBot,
  GrammyError: harness.FakeGrammyError,
  HttpError: harness.FakeHttpError,
  InlineKeyboard: harness.FakeInlineKeyboard,
  InputFile: harness.FakeInputFile,
}));

import { TelegramChannel } from '../src/channels/telegram.js';

function makeHandlers(record: { lost: string[]; recovered: string[] }) {
  return {
    onMessage: () => {},
    onPollingLost: (_channel: string, message: string) => {
      record.lost.push(message);
    },
    onPollingRecovered: () => {
      record.recovered.push('up');
    },
    log: () => {},
  };
}

describe('telegram reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.state.startCalls = 0;
    harness.state.failTimes = 0;
    harness.state.resolveStop = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un fallo terminal reintenta solo, avisa una vez y avisa al volver', async () => {
    const record = { lost: [] as string[], recovered: [] as string[] };
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    harness.state.failTimes = 1;
    await channel.start(makeHandlers(record));
    await vi.advanceTimersByTimeAsync(0);
    expect(record.lost).toHaveLength(1);
    expect(record.lost[0]).toContain('409');
    expect(channel.isReady()).toBe(false);
    // El reintento no es inmediato: backoff de 5 s.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.state.startCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.state.startCalls).toBe(2);
    expect(channel.isReady()).toBe(true);
    expect(record.recovered).toHaveLength(1);
    await channel.stop();
  });

  it('dos fallos seguidos avisan una sola vez y el backoff se dobla', async () => {
    const record = { lost: [] as string[], recovered: [] as string[] };
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    harness.state.failTimes = 2;
    await channel.start(makeHandlers(record));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.state.startCalls).toBe(2);
    expect(record.lost).toHaveLength(1);
    // Segundo reintento a los 10 s, no a los 5.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.state.startCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.state.startCalls).toBe(3);
    expect(record.lost).toHaveLength(1);
    expect(record.recovered).toHaveLength(1);
    await channel.stop();
  });

  it('stop() durante el backoff cancela el reintento', async () => {
    const record = { lost: [] as string[], recovered: [] as string[] };
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    harness.state.failTimes = 5;
    await channel.start(makeHandlers(record));
    await vi.advanceTimersByTimeAsync(0);
    await channel.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(harness.state.startCalls).toBe(1);
    expect(record.recovered).toHaveLength(0);
  });
});
