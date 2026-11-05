import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Avisos al llegar: «cuando llegue a casa recuérdame…» con la ubicación en directo. */
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
import {
  crearLlegada,
  createLlegadaTool,
  distanceM,
  LLEGADA_COMO,
  LlegadaStore,
  llegadaFiredText,
  llegadaIntent,
} from '../src/llegada.js';
import { STATE_ENTRIES } from '../src/state-files.js';

const CASA = { latitude: 43.5357, longitude: -5.6615 }; // Gijón
const LEJOS = { latitude: 43.3614, longitude: -5.8494 }; // Oviedo
const dirs: string[] = [];
const deps = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-llegada-'));
  dirs.push(dir);
  return {
    store: new LlegadaStore(join(dir, 'avisos-llegada.json'), () => 1),
    home: () => CASA,
    geocode: async (p: string) =>
      /oviedo/i.test(p) ? { ...LEJOS, label: 'Oviedo, Asturias' } : null,
  };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  harness.listeners.clear();
});

describe('qué frases son un aviso al llegar', () => {
  it.each([
    ['cuando llegue a casa recuérdame sacar la basura', 'casa', 'sacar la basura'],
    ['Recuérdame comprar pan cuando llegue a Oviedo', 'Oviedo', 'comprar pan'],
    ['en cuanto llegue a casa, avísame de llamar a mamá', 'casa', 'llamar a mamá'],
    ['recuérdame regar las plantas al llegar a casa.', 'casa', 'regar las plantas'],
  ])('%s', (text, place, what) => {
    expect(llegadaIntent(text)).toEqual({ place, text: what });
  });
  it.each([
    'recuérdame mañana a las 9 llamar al médico',
    'cuando llegue te llamo',
    'llego a casa a las 8',
  ])('no: %s', (text) => {
    expect(llegadaIntent(text)).toBeNull();
  });
});

describe('saltar al entrar en el sitio', () => {
  it('salta solo tras haberle visto fuera, una vez, y se borra', async () => {
    const d = deps();
    const reply = await crearLlegada(d, '7', 'casa', 'sacar la basura');
    expect(reply).toContain('cuando llegues a casa te recuerdo «sacar la basura»');
    expect(reply).toContain(LLEGADA_COMO);
    // Ya en casa al pedirlo: no salta al momento.
    expect(d.store.position('7', CASA)).toEqual([]);
    // Sale (Oviedo) y vuelve: ahora sí.
    expect(d.store.position('7', LEJOS)).toEqual([]);
    const fired = d.store.position('7', { latitude: 43.5361, longitude: -5.6618 });
    expect(fired.map(llegadaFiredText)).toEqual(['📍 Has llegado a casa: sacar la basura']);
    expect(d.store.list('7')).toEqual([]);
    expect(d.store.position('7', LEJOS)).toEqual([]);
  });

  it('otro chat no dispara los avisos de este', async () => {
    const d = deps();
    await crearLlegada(d, '7', 'casa', 'x');
    d.store.position('8', LEJOS);
    expect(d.store.position('8', CASA)).toEqual([]);
    expect(d.store.list('7')[0]?.armed).toBe(false);
  });

  it('una ciudad usa el buscador y un radio amplio; sin casa configurada lo explica', async () => {
    const d = deps();
    expect(await crearLlegada(d, '7', 'Oviedo', 'comprar pan')).toContain('Oviedo, Asturias');
    expect(d.store.list('7')[0]?.radiusM).toBe(3000);
    expect(await crearLlegada(d, '7', 'Narnia', 'x')).toContain('No encuentro «Narnia»');
    expect(await crearLlegada({ ...d, home: () => null }, '7', 'casa', 'x')).toContain(
      'PA_BRIEFING_LAT',
    );
    expect(Math.round(distanceM(CASA, LEJOS) / 1000)).toBe(25);
  });

  it('la herramienta del modelo crea, lista y borra', async () => {
    const d = deps();
    const tool = createLlegadaTool(d, () => '7');
    const run = async (args: Parameters<typeof tool.execute>[1]) =>
      ((await tool.execute('i', args)).content[0] as { text: string }).text;
    expect(await run({ accion: 'crear', lugar: 'casa', texto: 'regar' })).toContain('📍 Hecho');
    expect(await run({ accion: 'ver' })).toBe('1. Al llegar a casa: regar');
    expect(await run({ accion: 'borrar', id: 1 })).toBe('Aviso de llegada borrado.');
    expect(await run({ accion: 'ver' })).toBe('No tienes avisos de llegada.');
    expect(STATE_ENTRIES.some((e) => e.name === 'avisos-llegada.json')).toBe(true);
  });
});

describe('Telegram pasa la ubicación en directo', () => {
  it('cada movimiento (mensaje editado) llega como posición, sin aviso de «editado» ni turno', async () => {
    const got: Inbound[] = [];
    const positions: Array<{ chatId: string; latitude: number; longitude: number }> = [];
    const replies: string[] = [];
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    await channel.start({
      onMessage: (i: Inbound) => void got.push(i),
      onLocationUpdate: (u: { chatId: string; latitude: number; longitude: number }) =>
        void positions.push({ chatId: u.chatId, latitude: u.latitude, longitude: u.longitude }),
      log: () => {},
    } as never);
    const chat = { id: 7, type: 'private' };
    const base = { chat, from: { id: 7 }, me: { id: 1, username: 'bot' } };
    await harness.listeners.get('message')?.({
      ...base,
      message: { message_id: 1, date: 0, chat, location: { ...LEJOS, live_period: 3600 } },
      reply: async (t: string) => void replies.push(t),
    });
    await harness.listeners.get('edited_message')?.({
      ...base,
      editedMessage: { message_id: 1, date: 0, edit_date: 5, chat, location: CASA },
      reply: async (t: string) => void replies.push(t),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(positions).toEqual([
      { chatId: '7', ...LEJOS },
      { chatId: '7', ...CASA },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]?.text).toContain('(en directo; la sigo para los avisos al llegar)');
    expect(replies).toEqual([]);
  });
});
