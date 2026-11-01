import { describe, expect, it, vi } from 'vitest';

// Un vídeo enviado desde un tema (grupo con temas de Telegram) debe quedarse en ese
// tema, igual que fotos, documentos y notas de voz. Antes sendVideo no llevaba
// message_thread_id y el vídeo caía en «General».
const harness = vi.hoisted(() => {
  const calls: Array<{ method: string; options?: Record<string, unknown> }> = [];
  class Bot {
    readonly api = {
      sendVideo: async (_chatId: number, _file: unknown, options?: Record<string, unknown>) => {
        calls.push({ method: 'sendVideo', options });
        return { message_id: 5 };
      },
    };
  }
  return { calls, Bot };
});

vi.mock('grammy', () => ({
  Bot: harness.Bot,
  GrammyError: class extends Error {},
  HttpError: class extends Error {},
  InlineKeyboard: class {},
  InputFile: class {},
}));

import { readFileSync } from 'node:fs';
import { TelegramChannel } from '../src/channels/telegram.js';

function channel(): TelegramChannel {
  return new TelegramChannel({ token: 'test', allowedUserIds: [7] });
}

describe('sendVideo y los temas de Telegram', () => {
  it('lleva el vídeo al tema del que vino la petición', async () => {
    harness.calls.length = 0;
    await channel().sendVideo(42, Buffer.from('mp4'), 12.4, 'Pantalla', '7');
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.options).toMatchObject({
      caption: 'Pantalla (12s)',
      supports_streaming: true,
      message_thread_id: 7,
    });
  });

  it('sin tema, no manda message_thread_id (chat privado, como antes)', async () => {
    harness.calls.length = 0;
    await channel().sendVideo(42, Buffer.from('mp4'), 3, 'Camara');
    expect(harness.calls[0]?.options?.message_thread_id).toBeUndefined();
  });

  it('todas las llamadas a telegram.sendVideo del daemon pasan el tema', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/\.sendVideo\(([^;]*?)\)\s*(?:\.then|;)/gs)].map(
      (m) => m[1] ?? '',
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      // chatId, bytes, segundos, etiqueta, tema
      expect(args.split(',').filter((a) => a.trim()).length, args).toBe(5);
      expect(args, args).toMatch(/threadId/);
    }
  });
});
