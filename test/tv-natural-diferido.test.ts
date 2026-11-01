import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { parseTvCommand, tvOrderHasTime } from '../src/tv/natural.js';
import { tvChatCommand } from '../src/tv/tv-chat-command.js';

// Una orden con hora o condición («apaga la tele en 10 minutos») NO es una
// orden para YA: el parser determinista no programa nada, así que debe
// devolver null y dejar que el modelo (que sí sabe programar) la atienda.
// Antes se ejecutaba al momento: la tele se apagaba en vez de esperar.
describe('natural.ts: órdenes con hora no se ejecutan al momento', () => {
  it.each([
    'apaga la tele en 10 minutos',
    'apaga la tele en media hora',
    'apaga la tele en un rato',
    'apaga la tele dentro de 20 minutos',
    'apágala a las 12',
    'apaga la tele a la una',
    'apaga la tele cuando acabe la peli',
    'apaga la tele luego',
    'apaga la tele más tarde',
    'enciende la tele a las 8',
    'enciende la tele mañana',
    'enciende la tele esta noche',
    'pon Netflix a las 9',
    'baja el volumen en 5 minutos',
    'silencia la tele durante 10 minutos',
    'apaga la tele en 10 min',
    'apaga la tele después del partido',
  ])('«%s» → null (lo atiende el modelo)', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });

  it('/tv con hora no toca la tele y explica que se pida como mensaje normal', async () => {
    let ran = 0;
    const out = await tvChatCommand('apaga la tele en 10 minutos', {
      isOwner: true,
      run: async () => {
        ran += 1;
        return 'Tele apagada.';
      },
    });
    expect(ran).toBe(0);
    expect(out).toContain('lleva hora');
    expect(out).toContain('Escríbemelo como un mensaje normal');
  });

  it.each([
    ['apaga la tele', { action: 'power', on: false }],
    ['enciende la tele', { action: 'power', on: true }],
    ['baja el volumen a la mitad', { action: 'volumeHalf' }],
    ['volumen hasta la mitad', { action: 'volumeHalf' }],
    ['modo noche', { action: 'scene', scene: 'noche' }],
    ['noche de peli', { action: 'scene', scene: 'cine' }],
    ['pon la uno', { action: 'channel', channel: '1' }],
    ['sube un poco', { action: 'volumeStep', steps: 3 }],
  ])('sin hora sigue igual: «%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });
});

// «abre Netflix en la tele» lanzaba la app «netflix en la tele» (que no
// existe) y «pon YouTube en la tele» / «pon la 2 en la tele» no se entendían.
describe('natural.ts: «en la tele» al final', () => {
  it.each([
    ['abre netflix en la tele', { action: 'launch', appId: 'netflix' }],
    ['Abre YouTube en la TV', { action: 'launch', appId: 'youtube' }],
    ['pon youtube en la tele', { action: 'launch', appId: 'youtube' }],
    ['quiero ver netflix en el televisor', { action: 'launch', appId: 'netflix' }],
    ['pon la 2 en la tele', { action: 'channel', channel: '2' }],
    ['pon la uno en la tele', { action: 'channel', channel: '1' }],
    ['pausa en la tele', { action: 'media', command: 'pause' }],
  ])('«%s»', (text, intent) => {
    expect(parseTvCommand(text)).toEqual(intent);
  });

  it('«estado de la tele» sigue siendo estado', () => {
    expect(parseTvCommand('estado de la tele')).toEqual({ action: 'status' });
  });
});

describe('tool tv action=command con hora', () => {
  function deps() {
    const calls: string[] = [];
    const d: TvToolDeps = {
      shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
      foreground: async () => ({ appId: 'x', category: [] }),
      apps: async () => [],
      launch: async (id) => void calls.push(`launch:${id}`),
      key: async (n) => void calls.push(`key:${n}`),
      toast: async () => {},
      power: async (on) => void calls.push(`power:${on}`),
      saveFrame: () => '',
      getState: () => null,
      setState: () => {},
    };
    return { d, calls };
  }

  it('no apaga la tele y le dice al modelo que lo programe, no que lo haga ya', async () => {
    const { d, calls } = deps();
    await expect(
      createTvTool(d).execute('id', {
        action: 'command',
        text: 'apaga la tele en 10 minutos',
      } as never),
    ).rejects.toThrow(/lleva hora.*no ha tocado la tele.*programala/);
    expect(calls).toEqual([]);
  });

  it('tvOrderHasTime solo marca órdenes con hora', () => {
    expect(tvOrderHasTime('apaga la tele en 10 minutos')).toBe(true);
    expect(tvOrderHasTime('enciende la tele a las 8')).toBe(true);
    expect(tvOrderHasTime('apaga la tele')).toBe(false);
    expect(tvOrderHasTime('baja a la mitad')).toBe(false);
    expect(tvOrderHasTime('modo noche')).toBe(false);
  });
});
