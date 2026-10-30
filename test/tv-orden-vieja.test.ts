import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Telegram entrega al arrancar lo que se mandó con Asistenta apagada: una orden
// vieja a la tele («pausa», «cierra la app»…) no debe llegar a la tele tarde.
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
import { Store } from '../src/db.js';
import { tvPlugin } from '../src/plugins/tv.js';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { STALE_TV_ORDER_MS, staleTvOrderNotice } from '../src/tv/stale-order.js';

afterEach(() => harness.listeners.clear());

const NOW = Date.parse('2026-10-30T23:30:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('cuándo es vieja una orden a la tele', () => {
  it('reciente, o sin fecha (panel, voz, rutinas): se hace', () => {
    expect(staleTvOrderNotice(undefined, NOW)).toBeNull();
    expect(staleTvOrderNotice(ago(30_000), NOW)).toBeNull();
    expect(staleTvOrderNotice(ago(STALE_TV_ORDER_MS), NOW)).toBeNull();
    expect(staleTvOrderNotice('no es fecha', NOW)).toBeNull();
  });

  it('de hace más de 2 minutos: no se hace y se dice claro', () => {
    const n = staleTvOrderNotice(ago(25 * 60_000), NOW);
    expect(n).toMatch(/No he tocado la tele/);
    expect(n).toMatch(/hace 25 min/);
    expect(n).toMatch(/repítela/);
    expect(staleTvOrderNotice(ago(3 * 3_600_000), NOW)).toMatch(/hace 3 h/);
  });
});

describe('Telegram dice cuándo se envió el mensaje', () => {
  it('el mensaje lleva sentAt a partir de msg.date', async () => {
    const got: Inbound[] = [];
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    await channel.start({ onMessage: (i: Inbound) => void got.push(i), log: () => {} } as never);
    await harness.listeners.get('message')?.({
      message: {
        message_id: 5,
        date: 1_793_400_000,
        chat: { id: 42, type: 'private' },
        text: 'pausa',
      },
      from: { id: 7 },
      chat: { id: 42, type: 'private' },
      me: { id: 1, username: 'bot' },
      reply: async () => {},
    });
    await channel.stop?.();
    expect(got[0]?.sentAt).toBe(new Date(1_793_400_000 * 1000).toISOString());
  });
});

function deps(calls: string[], stale: string | null): TvToolDeps {
  return {
    shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [],
    launch: async (id) => void calls.push(`launch ${id}`),
    key: async (k) => void calls.push(`key ${k}`),
    toast: async () => void calls.push('toast'),
    power: async (on) => {
      calls.push(`power ${on}`);
      return { via: 'ssap', verified: true };
    },
    status: async () => ({ power: 'on' }) as never,
    saveFrame: () => '',
    getState: () => null,
    setState: () => {},
    staleOrder: () => stale,
  };
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join(' ');

describe('la tool tv con un mensaje viejo', () => {
  const VIEJA = 'No he tocado la tele: esa orden es de un mensaje de hace 25 min.';

  it.each([
    { action: 'key', name: 'HOME' },
    { action: 'power', on: true },
    { action: 'command', text: 'pausa' },
    { action: 'command', text: 'pon la tele' },
    { action: 'launch', app: 'youtube' },
  ])('$action no toca la tele y lo dice', async (args) => {
    const calls: string[] = [];
    const res = await createTvTool(deps(calls, VIEJA)).execute('t', args as never);
    expect(calls).toEqual([]);
    expect(textOf(res)).toBe(VIEJA);
  });

  it('mirar la tele sí se puede (solo lectura)', async () => {
    const calls: string[] = [];
    const res = await createTvTool(deps(calls, VIEJA)).execute('t', { action: 'status' } as never);
    expect(textOf(res)).not.toMatch(/No he tocado/);
  });

  it('mensaje reciente: la orden se hace como siempre', async () => {
    const calls: string[] = [];
    await createTvTool(deps(calls, null)).execute('t', { action: 'key', name: 'HOME' } as never);
    expect(calls).toEqual(['key HOME']);
  });

  it('el plugin pasa el aviso a la tool', async () => {
    const [tool] = tvPlugin.tools({ store: new Store(), staleOrder: () => VIEJA });
    const res = await tool?.execute('t', { action: 'key', name: 'HOME' } as never);
    expect(textOf(res as never)).toBe(VIEJA);
  }, 20_000); // abrir la Store tarda con la máquina cargada

  it('el daemon mira la fecha del mensaje del turno y la de /tv', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/staleOrder: \(\) =>\s+staleTvOrderNotice\(inboundFor\(thread\)\.sentAt/);
    expect(cli).toMatch(/staleTvOrderNotice\(inbound\.sentAt/);
  });
});
