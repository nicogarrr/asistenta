/**
 * Caracterizacion de la integracion Smart TV (LG webOS) tal y como funciona
 * HOY: fija el comportamiento observable del cliente SSAP y de la tool `tv`
 * contra una tele simulada (test/helpers/fake-webos-tv.ts), sin red ni tele
 * real. Si uno de estos tests cambia, el comportamiento de la tele cambia:
 * revisalo con cuidado (la integracion funciona bien en casa de Nico).
 */
import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { assertTvHost, pairTv, tvRequest, tvToast } from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.237';

describe('caracterizacion SSAP (tele simulada)', () => {
  it('request: un socket wss://IP:3001, registro con la client-key guardada y uri ssap://', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.applicationManager/getForegroundAppInfo': () => ({
          returnValue: true,
          appId: 'netflix',
        }),
      },
    });
    const res = await tvRequest(
      HOST,
      'KEY123',
      'com.webos.applicationManager/getForegroundAppInfo',
      {},
      { factory: tv.factory },
    );
    expect(res).toEqual({ returnValue: true, appId: 'netflix' });
    expect(tv.urls).toEqual([`wss://${HOST}:3001`]);
    expect(tv.registers).toEqual(['KEY123']);
    expect(tv.requests.map((r) => r.uri)).toEqual([
      'com.webos.applicationManager/getForegroundAppInfo',
    ]);
    expect(tv.allClosed()).toBe(true);
  });

  it('pairing: registro sin client-key y devuelve la clave + canal seguro', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'NEWKEY' });
    await expect(pairTv(HOST, { factory: tv.factory })).resolves.toEqual({
      clientKey: 'NEWKEY',
      secure: true,
    });
    expect(tv.registers).toEqual([undefined]);
    expect(tv.allClosed()).toBe(true);
  });

  it('client-key revocada: error de registro legible y socket cerrado', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'OTRA' });
    await expect(
      tvRequest(HOST, 'KEY123', 'system/turnOff', {}, { factory: tv.factory }),
    ).rejects.toThrow(/La TV rechazo el registro/);
    expect(tv.requests).toEqual([]);
    expect(tv.allClosed()).toBe(true);
  });

  it('tele apagada: sin downgrade a ws por defecto y mensaje con la pista de red', async () => {
    const tv = new FakeWebOsTv({ reachable: false });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'system/turnOff',
        {},
        {
          factory: tv.factory,
          connectRetryDelayMs: 1,
        },
      ),
    ).rejects.toThrow(
      /No se pudo conectar con la TV en 192\.168\.1\.237 \(wss:\/\/3001\)\. ¿Encendida y en la misma red\?/,
    );
    // Un rechazo inmediato se reintenta DOS veces con backoff (connectRetries=2):
    // antes del open no se envia nada, asi que no hay orden duplicada.
    expect(tv.urls).toEqual([`wss://${HOST}:3001`, `wss://${HOST}:3001`, `wss://${HOST}:3001`]);
    expect(tv.requests).toEqual([]);
  });

  it('tele apagada con tv:secure=0: prueba wss y luego ws', async () => {
    const tv = new FakeWebOsTv({ reachable: false });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'system/turnOff',
        {},
        { factory: tv.factory, allowPlaintext: true, connectRetries: 0 },
      ),
    ).rejects.toThrow(/wss:\/\/3001 y ws:\/\/3000/);
    expect(tv.urls).toEqual([`wss://${HOST}:3001`, `ws://${HOST}:3000`]);
  });

  it('returnValue false: rechazo con el errorText de la tele', async () => {
    const tv = new FakeWebOsTv({
      handlers: { 'system/turnOff': () => ({ returnValue: false, errorText: 'not permitted' }) },
    });
    await expect(
      tvRequest(HOST, 'KEY123', 'system/turnOff', {}, { factory: tv.factory }),
    ).rejects.toThrow('La TV rechazo system/turnOff: not permitted');
  });

  it('error SSAP: mensaje con el error remoto', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'audio/setVolume': () => {
          throw new Error('404 no such service');
        },
      },
    });
    await expect(
      tvRequest(HOST, 'KEY123', 'audio/setVolume', { volume: 5 }, { factory: tv.factory }),
    ).rejects.toThrow('La TV devolvio error en audio/setVolume: 404 no such service');
  });

  it('tele muda: timeout del comando con su uri y sus segundos', async () => {
    const tv = new FakeWebOsTv({ handlers: { 'system/turnOff': () => 'silent' } });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'system/turnOff',
        {},
        {
          factory: tv.factory,
          commandTimeoutMs: 50,
        },
      ),
    ).rejects.toThrow('La TV no respondio a system/turnOff en 0.05s.');
    expect(tv.allClosed()).toBe(true);
  });

  it('toast: createToast con el mensaje tal cual', async () => {
    const tv = new FakeWebOsTv();
    await tvToast(HOST, 'KEY123', 'hola Nico', { factory: tv.factory });
    expect(tv.requests).toEqual([
      { uri: 'system.notifications/createToast', payload: { message: 'hola Nico' } },
    ]);
  });

  it('host: solo IPv4 privada sin esquema ni puerto', () => {
    expect(assertTvHost(' 192.168.1.237 ')).toBe('192.168.1.237');
    expect(() => assertTvHost('8.8.8.8')).toThrow(/IP LOCAL/);
    expect(() => assertTvHost('http://192.168.1.237')).toThrow(/IP LOCAL/);
    expect(() => assertTvHost('192.168.1.237:3001')).toThrow(/IP LOCAL/);
  });
});

function toolDeps(over: Partial<TvToolDeps> = {}) {
  const calls: string[] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.alloc(30_000, 1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [{ id: 'netflix', title: 'Netflix' }],
    launch: async (id) => void calls.push(`launch:${id}`),
    key: async (n) => void calls.push(`key:${n}`),
    toast: async (m) => void calls.push(`toast:${m}`),
    power: async (on) => void calls.push(`power:${on}`),
    saveFrame: () => '/tmp/tv.jpg',
    getState: () => null,
    setState: () => {},
    ...over,
  };
  return { d, calls };
}

type R = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const run = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never) as unknown as Promise<R>;
const text = (r: R) => r.content.map((c) => c.text ?? '').join(' ');

describe('caracterizacion tool tv', () => {
  it('power exige on explicito y no toca la tele sin el', async () => {
    const { d, calls } = toolDeps();
    await expect(run(d, { action: 'power' })).rejects.toThrow(/necesita on: true/);
    expect(calls).toEqual([]);
  });

  it('power on/off: orden enviada sin confirmar estado fisico', async () => {
    const { d, calls } = toolDeps();
    const on = await run(d, { action: 'power', on: true });
    const off = await run(d, { action: 'power', on: false });
    expect(calls).toEqual(['power:true', 'power:false']);
    expect(text(on)).toMatch(/^Orden de encender la pantalla enviada/);
    expect(text(off)).toBe('Orden de apagar la tele enviada. No confirma el estado fisico.');
    expect(on.details).toEqual({ on: true, verified: false });
  });

  it('launch: appId recortado y texto fijo', async () => {
    const { d, calls } = toolDeps();
    const r = await run(d, { action: 'launch', appId: '  netflix ' });
    expect(calls).toEqual(['launch:netflix']);
    expect(text(r)).toBe('He lanzado netflix en la tele.');
    await expect(run(d, { action: 'launch' })).rejects.toThrow(/necesita appId/);
  });

  it('key: alias VOLUP/VOLDOWN -> VOLUMEUP/VOLUMEDOWN, minusculas aceptadas', async () => {
    const { d, calls } = toolDeps();
    await run(d, { action: 'key', name: 'volup' });
    await run(d, { action: 'key', name: 'VOLDOWN' });
    await run(d, { action: 'key', name: 'home' });
    expect(calls).toEqual(['key:VOLUMEUP', 'key:VOLUMEDOWN', 'key:HOME']);
    await expect(run(d, { action: 'key', name: 'POWER' })).rejects.toThrow(/nombre valido/);
  });

  it('acciones Glasshouse sin cliente: error claro y nada enviado', async () => {
    const { d } = toolDeps();
    await expect(run(d, { action: 'volume', level: 10 })).rejects.toThrow(/va por Glasshouse/);
    await expect(run(d, { action: 'mute', on: true })).rejects.toThrow(/va por Glasshouse/);
  });

  it('volume: entero 0-100 absoluto; input normalizado a minusculas', async () => {
    const gh: string[] = [];
    const { d } = toolDeps({ ghControl: async (a, v) => void gh.push(`${a}:${String(v)}`) });
    await expect(run(d, { action: 'volume', level: 101 })).rejects.toThrow(/entero 0-100/);
    await expect(run(d, { action: 'volume', level: 2.5 })).rejects.toThrow(/entero 0-100/);
    const r = await run(d, { action: 'volume', level: 13 });
    await run(d, { action: 'input', input: 'HDMI2' });
    expect(text(r)).toBe('Volumen puesto a 13 (orden enviada).');
    expect(gh).toEqual(['volume:13', 'input:hdmi2']);
  });

  it('url: solo http(s)', async () => {
    const { d } = toolDeps({ ghControl: async () => {} });
    await expect(run(d, { action: 'url', url: 'javascript:alert(1)' })).rejects.toThrow(
      /http:\/\/ o https/,
    );
  });

  it('las mutaciones van en cola: la segunda espera a la primera', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const { d } = toolDeps({
      launch: (id) =>
        new Promise<void>((res) => {
          order.push(`start:${id}`);
          if (id === 'a') release = () => res();
          else res();
        }),
    });
    const p1 = run(d, { action: 'launch', appId: 'a' });
    const p2 = run(d, { action: 'launch', appId: 'b' });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start:a']);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start:a', 'start:b']);
  });

  it('un fallo de transporte se propaga tal cual al modelo', async () => {
    const { d } = toolDeps({
      launch: async () => {
        throw new Error('No se pudo conectar con la TV en 192.168.1.237 (wss://3001).');
      },
    });
    await expect(run(d, { action: 'launch', appId: 'netflix' })).rejects.toThrow(
      /No se pudo conectar con la TV/,
    );
  });
});
