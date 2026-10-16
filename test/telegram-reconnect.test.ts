import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reconnect canary. The failure shape follows grammY 1.35.0 exactly: onStart
 * fires after init/deleteWebhook and BEFORE the first getUpdates, and a
 * terminal 409 is thrown by the polling loop AFTER onStart (auditor, #153
 * ronda 1). Health evidence is a completed getUpdates — an empty batch
 * counts — never onStart.
 */
const harness = vi.hoisted(() => {
  type OnStart = (me: { username: string; id: number }) => void;
  type Transformer = (
    prev: (method: string, payload: unknown, signal?: unknown) => Promise<unknown>,
    method: string,
    payload: unknown,
    signal?: unknown,
  ) => Promise<unknown>;
  const state = {
    startCalls: 0,
    stopFails: false,
    /** getUpdates failures still to throw, each AFTER onStart like grammY. */
    failTimes: 0,
    /** Delay onStart by one macrotask, to test a late onStart after stop(). */
    deferOnStart: false,
    transformers: [] as Transformer[],
    resolveStop: undefined as undefined | (() => void),
    /** Raw responses pushed through the transformer chain (canary evidence). */
    rawSeen: [] as Array<{ ok: boolean; error_code?: number }>,
  };
  class FakeBot {
    readonly api = {
      config: {
        use: (t: Transformer) => {
          state.transformers.push(t);
          return this;
        },
      },
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => true,
      setMyCommands: async () => true,
      deleteMessage: async () => true,
      sendVideo: async () => ({ message_id: 2 }),
      sendDocument: async () => ({ message_id: 3 }),
    };
    on(): void {}
    catch(): void {}
    async start(opts?: { onStart?: OnStart }): Promise<void> {
      state.startCalls++;
      if (state.deferOnStart) {
        await new Promise<void>((r) => {
          setTimeout(r, 0);
        });
      }
      // Like grammY: onStart proves setup only; the first getUpdates comes next.
      opts?.onStart?.({ username: 'bot', id: 1 });
      // Like ApiClient.callApi (client.js:92-97): the transformer chain sees
      // the RAW response and the error is thrown only AFTER it completes.
      let raw: { ok: boolean; result?: unknown[]; error_code?: number; description?: string };
      if (state.failTimes > 0) {
        state.failTimes--;
        raw = {
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates request',
        };
      } else {
        raw = { ok: true, result: [] };
      }
      state.rawSeen.push({ ok: raw.ok, error_code: raw.error_code });
      let result: unknown = raw;
      for (const t of state.transformers) {
        result = await t(async () => raw, 'getUpdates', {}, undefined);
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        (result as { ok?: boolean }).ok !== true
      ) {
        throw new Error('409 Conflict: terminated by other getUpdates request');
      }
      // Like grammY: the promise stays pending while polling lives.
      await new Promise<void>((resolve) => {
        state.resolveStop = resolve;
      });
    }
    async stop(): Promise<void> {
      if (state.stopFails) throw new Error('fixture stop failed');
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
    harness.state.stopFails = false;
    harness.state.failTimes = 0;
    harness.state.deferOnStart = false;
    harness.state.resolveStop = undefined;
    harness.state.transformers.length = 0;
    harness.state.rawSeen.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('409 persistente tras onStart: una pérdida, cero recuperaciones falsas, backoff 5s/10s/20s hasta polling sano', async () => {
    const record = { lost: [] as string[], recovered: [] as string[] };
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    harness.state.failTimes = 3;
    await channel.start(makeHandlers(record));
    await vi.advanceTimersByTimeAsync(0);
    // Ciclo 1: onStart YA se llamó y aun así ready es falso — onStart no
    // demuestra polling sano. El 409 llega después, como en grammY.
    expect(harness.state.startCalls).toBe(1);
    expect(channel.isReady()).toBe(false);
    expect(record.lost).toHaveLength(1);
    expect(record.lost[0]).toContain('409');
    expect(record.recovered).toHaveLength(0);
    // El 409 paso POR el transformer como respuesta completada {ok:false} — el
    // camino vulnerable de la ronda 1 — y aun asi no marco salud.
    expect(harness.state.rawSeen).toContainEqual({ ok: false, error_code: 409 });
    // Backoff 5s exacto, sin atajo por onStart.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.state.startCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.state.startCalls).toBe(2);
    expect(channel.isReady()).toBe(false);
    expect(record.lost).toHaveLength(1);
    expect(record.recovered).toHaveLength(0);
    // Segundo fallo: el backoff NO se resetea a 5s (onStart no resetea nada).
    await vi.advanceTimersByTimeAsync(9_999);
    expect(harness.state.startCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.state.startCalls).toBe(3);
    expect(record.lost).toHaveLength(1);
    // Tercer fallo: 20s.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(harness.state.startCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    // Cuarto intento: getUpdates completo (lote vacío) = salud real.
    expect(harness.state.startCalls).toBe(4);
    expect(channel.isReady()).toBe(true);
    expect(record.lost).toHaveLength(1);
    expect(record.recovered).toHaveLength(1);
    await channel.stop();
  });

  it('un onStart tardío tras stop() no marca ready ni reintenta', async () => {
    const record = { lost: [] as string[], recovered: [] as string[] };
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    harness.state.deferOnStart = true;
    await channel.start(makeHandlers(record));
    await channel.stop();
    // El onStart diferido llega DESPUÉS del stop: no debe resucitar el canal.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(harness.state.startCalls).toBe(1);
    expect(channel.isReady()).toBe(false);
    expect(record.lost).toHaveLength(0);
    expect(record.recovered).toHaveLength(0);
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

  it('polling sano que luego muere sin stop(): avisa y reintenta hasta recuperarse', async () => {
    const record = { lost: [] as string[], recovered: [] as string[] };
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    await channel.start(makeHandlers(record));
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.isReady()).toBe(true);
    expect(record.recovered).toHaveLength(0);
    // El polling muere (el resolve llega sin stop() propio): misma reacción
    // que un rechazo — aviso una vez y reintento.
    harness.state.resolveStop?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(record.lost).toHaveLength(1);
    expect(record.lost[0]).toContain('polling ended');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.state.startCalls).toBe(2);
    expect(channel.isReady()).toBe(true);
    expect(record.recovered).toHaveLength(1);
    await channel.stop();
  });
  it('strict stop propagates polling failure instead of claiming a clean drain', async () => {
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [1] });
    harness.state.stopFails = true;
    await expect(channel.stop(true)).rejects.toThrow('cierre de polling');
    await expect(channel.stop()).resolves.toBeUndefined();
  });
});
