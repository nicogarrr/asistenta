import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Un punto compartido (sin directo o un sitio del mapa) no es «estar ahí». */
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
import { crearLlegada, guardarSitio, LlegadaStore } from '../src/llegada.js';

const CASA = { latitude: 43.5357, longitude: -5.6615 };
const GYM = { latitude: 43.5401, longitude: -5.6489 };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  harness.listeners.clear();
});

describe('Telegram distingue directo de punto compartido', () => {
  it('directo → live; ubicación suelta y sitio del mapa → live:false (con las coordenadas del sitio)', async () => {
    const got: Array<{ latitude: number; longitude: number; live?: boolean }> = [];
    const channel = new TelegramChannel({ token: 't', allowedUserIds: [7] });
    await channel.start({
      onMessage: () => {},
      onLocationUpdate: (u: { latitude: number; longitude: number; live?: boolean }) =>
        void got.push({ latitude: u.latitude, longitude: u.longitude, live: u.live }),
      log: () => {},
    } as never);
    const chat = { id: 7, type: 'private' };
    const base = { chat, from: { id: 7 }, me: { id: 1, username: 'bot' }, reply: async () => {} };
    const send = (message: object) => harness.listeners.get('message')?.({ ...base, message });
    await send({ message_id: 1, date: 0, chat, location: { ...CASA, live_period: 3600 } });
    await send({ message_id: 2, date: 0, chat, location: GYM });
    await send({
      message_id: 3,
      date: 0,
      chat,
      location: CASA,
      venue: { location: GYM, title: 'Gimnasio', address: 'C/ Mayor 1' },
    });
    await harness.listeners.get('edited_message')?.({
      ...base,
      editedMessage: { message_id: 1, date: 0, edit_date: 5, chat, location: GYM },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([
      { ...CASA, live: true },
      { ...GYM, live: false },
      { ...GYM, live: false },
      { ...GYM, live: true },
    ]);
  });
});

describe('un punto compartido no dispara avisos', () => {
  it('mandar el punto del gimnasio estando en casa no salta «al salir de casa», pero sirve para guardarlo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-tg27-punto-'));
    dirs.push(dir);
    const store = new LlegadaStore(join(dir, 'avisos-llegada.json'), () => 1);
    const deps = { store, home: () => CASA, geocode: async () => null };
    await crearLlegada(deps, '7', 'casa', 'las llaves', 'salir');
    store.position('7', CASA); // en casa (directo): armado
    store.puntoCompartido('7', GYM); // manda el punto del gimnasio
    expect(store.list('7')).toHaveLength(1);
    expect(guardarSitio(store, '7', { name: 'el gimnasio', explicito: false })).toContain(
      'Guardado «el gimnasio»',
    );
    expect(store.sitio('7', 'gimnasio')).toMatchObject(GYM);
  });
});
