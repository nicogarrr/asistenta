import { afterEach, describe, expect, it, vi } from 'vitest';

// Una descarga de Telegram que se cuelga devolvía null a los 60 s, pero la conexión
// seguía abierta para siempre (fetch sin señal): cada audio colgado dejaba un socket
// y su memoria vivos.
const harness = vi.hoisted(() => {
  class Bot {
    readonly api = {
      getFile: async () => ({ file_path: 'voice/nota.oga' }),
    };
  }
  return { Bot };
});

vi.mock('grammy', () => ({
  Bot: harness.Bot,
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
  InlineKeyboard: class {},
  InputFile: class {},
}));

import { TelegramChannel } from '../src/channels/telegram.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Telegram: descarga colgada', () => {
  it('al pasar el tiempo límite corta la conexión, no solo deja de esperarla', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }),
    );
    const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
    const result = channel.downloadFile('abc');
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(result).resolves.toBeNull();
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it('una descarga normal sigue funcionando', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
    const buf = await channel.downloadFile('abc');
    expect(buf ? [...buf] : null).toEqual([1, 2, 3]);
  });
});
