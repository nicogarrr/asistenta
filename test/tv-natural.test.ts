import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { needsAppLookup, normalizeTvText, resolveAppId } from '../src/tv/apps.js';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

describe('ordenes naturales en castellano', () => {
  const cases: Array<[string, unknown]> = [
    ['apaga la tele', { action: 'power', on: false }],
    ['Apaga la televisión, porfa', { action: 'power', on: false }],
    ['apágala', null],
    ['enciende la tele', { action: 'power', on: true }],
    ['enciende', { action: 'power', on: true }],
    ['volumen a 20', { action: 'volume', level: 20 }],
    ['pon el volumen al 15', { action: 'volume', level: 15 }],
    ['baja el volumen a diez', { action: 'volume', level: 10 }],
    ['volumen a 200', null],
    ['sube el volumen', { action: 'volumeStep', steps: 3 }],
    ['sube un poco', { action: 'volumeStep', steps: 3 }],
    ['baja 5', { action: 'volumeStep', steps: -5 }],
    ['bájale dos', { action: 'volumeStep', steps: -2 }],
    ['sube el volumen 40', { action: 'volumeStep', steps: 15 }],
    ['más alto', { action: 'volumeStep', steps: 3 }],
    ['baja la persiana', null],
    ['silencio', { action: 'mute', on: true }],
    ['apaga el sonido', { action: 'mute', on: true }],
    ['quita el silencio', { action: 'mute', on: false }],
    ['canal 5', { action: 'channel', channel: '5' }],
    ['pon el canal 024', { action: 'channel', channel: '24' }],
    ['pon la 1', { action: 'channel', channel: '1' }],
    ['siguiente canal', { action: 'channel', channel: 'up' }],
    ['canal anterior', { action: 'channel', channel: 'down' }],
    ['abre Netflix', { action: 'launch', appId: 'netflix' }],
    ['pon YouTube', { action: 'launch', appId: 'youtube' }],
    ['abre Disney+', { action: 'launch', appId: 'disney plus' }],
    ['quiero ver RTVE Play', { action: 'launch', appId: 'rtve play' }],
    ['pon algo de música', null],
    ['pausa', { action: 'media', command: 'pause' }],
    ['dale al play', { action: 'media', command: 'play' }],
    ['pon el HDMI 2', { action: 'input', input: 'hdmi2' }],
    ['¿qué está viendo?', { action: 'status' }],
    ['¿está la tele encendida?', { action: 'status' }],
    ['cuéntame un chiste', null],
    ['', null],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}"`, () => {
      expect(parseTvCommand(text)).toEqual(expected);
    });
  }

  it('describe en castellano lo entendido', () => {
    expect(describeTvIntent({ action: 'volumeStep', steps: -2 })).toBe('bajar el volumen 2');
    expect(describeTvIntent({ action: 'channel', channel: '5' })).toBe('poner el canal 5');
    expect(describeTvIntent({ action: 'input', input: 'hdmi2' })).toBe('cambiar a HDMI2');
  });
});

describe('resolver el nombre de una app al id de webOS', () => {
  const installed = [
    { id: 'netflix', title: 'Netflix' },
    { id: 'youtube.leanback.v4', title: 'YouTube' },
    { id: 'es.rtve.play', title: 'RTVE Play' },
    { id: 'com.dazn.app', title: 'DAZN' },
    { id: 'es.movistarplus.app', title: 'Movistar Plus+' },
  ];

  it('id exacto, alias, titulo, y si no, tal cual', () => {
    expect(resolveAppId('netflix', installed)).toEqual({ id: 'netflix', how: 'id' });
    expect(resolveAppId('YouTube', null)).toEqual({ id: 'youtube.leanback.v4', how: 'alias' });
    expect(resolveAppId('Disney+', null).id).toBe('com.disney.disneyplus-prod');
    expect(resolveAppId('dazn', installed)).toEqual({
      id: 'com.dazn.app',
      how: 'title',
      title: 'DAZN',
    });
    expect(resolveAppId('movistar', installed).id).toBe('es.movistarplus.app');
    expect(resolveAppId('rtve play', installed).id).toBe('es.rtve.play');
    expect(resolveAppId('Filmin', installed)).toEqual({ id: 'Filmin', how: 'raw' });
  });

  it('solo pide la lista a la tele cuando hace falta', () => {
    expect(needsAppLookup('netflix')).toBe(false);
    expect(needsAppLookup('YouTube')).toBe(false);
    expect(needsAppLookup('com.webos.app.hdmi1')).toBe(false);
    expect(needsAppLookup('DAZN')).toBe(true);
    expect(normalizeTvText('  Música  ')).toBe('musica');
  });
});

function deps(over: Partial<TvToolDeps> = {}) {
  const calls: string[] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'x', category: [] }),
    apps: async () => {
      calls.push('apps');
      return [{ id: 'com.dazn.app', title: 'DAZN' }];
    },
    launch: async (id) => void calls.push(`launch:${id}`),
    key: async (n) => void calls.push(`key:${n}`),
    toast: async () => {},
    power: async (on) => void calls.push(`power:${on}`),
    saveFrame: () => '',
    getState: () => null,
    setState: () => {},
    ...over,
  };
  return { d, calls };
}
type R = { content: Array<{ text?: string }>; details: Record<string, unknown> };
const run = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never) as unknown as Promise<R>;
const text = (r: R) => r.content.map((c) => c.text ?? '').join(' ');

describe('tool tv: launch por nombre, canal, volumen por pasos y command', () => {
  it('ANTES launch "YouTube" mandaba un id inexistente; ahora lanza youtube.leanback.v4 sin pedir la lista', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'launch', appId: 'YouTube' });
    expect(calls).toEqual(['launch:youtube.leanback.v4']);
    expect(text(r)).toBe('He lanzado YouTube (youtube.leanback.v4) en la tele.');
    expect(r.details).toMatchObject({
      appId: 'youtube.leanback.v4',
      asked: 'YouTube',
      resolvedBy: 'alias',
    });
  });

  it('un nombre desconocido se busca en las apps instaladas', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'launch', appId: 'dazn' });
    expect(calls).toEqual(['apps', 'launch:com.dazn.app']);
    expect(text(r)).toBe('He lanzado DAZN (com.dazn.app) en la tele.');
  });

  it('un id real no cambia (ni pide la lista)', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'launch', appId: 'netflix' });
    expect(calls).toEqual(['launch:netflix']);
    expect(text(r)).toBe('He lanzado netflix en la tele.');
  });

  it('volumeStep: N teclas en una sola entrada de la cola', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'volumeStep', steps: -3 });
    expect(calls).toEqual(['key:VOLUMEDOWN', 'key:VOLUMEDOWN', 'key:VOLUMEDOWN']);
    expect(text(r)).toBe('Volumen bajado 3 pasos (sin confirmacion de la tele).');
    await expect(run(d, { action: 'volumeStep', steps: 0 })).rejects.toThrow(/entre -15 y 15/);
    await expect(run(d, { action: 'volumeStep', steps: 50 })).rejects.toThrow(/entre -15 y 15/);
  });

  it('channel: arriba/abajo y numero con ENTER', async () => {
    const { d, calls } = deps();
    await run(d, { action: 'channel', channel: 'up' });
    await run(d, { action: 'channel', channel: '24' });
    expect(calls).toEqual(['key:CHANNELUP', 'key:2', 'key:4', 'key:ENTER']);
    await expect(run(d, { action: 'channel', channel: 'antena3' })).rejects.toThrow(
      /up, down o un numero/,
    );
  });

  it('command: entiende y ejecuta, diciendo que entendio', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'command', text: 'apaga la tele' });
    expect(calls).toEqual(['power:false']);
    expect(text(r)).toMatch(/^Entendido: apagar la tele\. Orden de apagar la tele enviada/);
    expect(r.details.intent).toEqual({ action: 'power', on: false });
    const r2 = await run(d, { action: 'command', text: 'abre Netflix' });
    expect(calls.at(-1)).toBe('launch:netflix');
    expect(text(r2)).toMatch(/^Entendido: abrir netflix\./);
  });

  it('command: si no entiende, no toca la tele y da ejemplos', async () => {
    const { d, calls } = deps();
    await expect(run(d, { action: 'command', text: 'haz la cena' })).rejects.toThrow(
      /No he entendido "haz la cena".*Ejemplos/,
    );
    expect(calls).toEqual([]);
  });
});
