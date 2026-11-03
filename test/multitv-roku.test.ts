import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vault = new Map<string, string>();
vi.mock('../src/vault.js', () => ({
  vaultGet: async (k: string) => vault.get(k),
  vaultSet: async (k: string, v: string) => {
    vault.set(k, v);
  },
  vaultSetMany: async (o: Record<string, string>) => {
    for (const [k, v] of Object.entries(o)) vault.set(k, v);
  },
}));
const lgCalls: string[] = [];
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    tvRequest: async (host: string, _k: string, uri: string) => {
      lgCalls.push(`${host}|${uri}`);
      return { returnValue: true };
    },
    tvKey: async (host: string) => void lgCalls.push(`${host}|key`),
  };
});
vi.mock('../src/tv/glasshouse.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/glasshouse.js')>();
  class FakeGlasshouse {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: proxy de prueba, cualquier método falla como inalcanzable
      return new Proxy(this, {
        get: (_t, prop) =>
          prop === 'then'
            ? undefined
            : async () => {
                throw new real.GlasshouseUnavailableError('sin glasshouse en el test');
              },
      });
    }
  }
  return { ...real, GlasshouseClient: FakeGlasshouse };
});
vi.mock('../src/tv/auto-select.js', async (orig) => ({
  ...(await orig<typeof import('../src/tv/auto-select.js')>()),
  ensureActiveTv: async () => ({}),
}));

import { Store } from '../src/db.js';
import { tvToolDeps } from '../src/plugins/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { discoverWebOsTvs, isRoku, type UdpLike } from '../src/tv/discover.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { parseRegistry } from '../src/tv/registry.js';
import { rokuDeviceInfo, rokuDriver } from '../src/tv/roku.js';
import { tvCommand } from '../src/tv/tv-cli.js';

const DEVICE_INFO =
  '<device-info><serial-number>X00400ABCDEF</serial-number><model-name>TCL 55R635</model-name><user-device-name>Dormitorio</user-device-name><is-tv>true</is-tv></device-info>';

function fakeFetch(status = 200) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return new Response(String(url).endsWith('/query/device-info') ? DEVICE_INFO : '', { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('driver Roku (ECP, fetch falso)', () => {
  it('teclas, volumen por pasos, apps y apagado van al puerto 8060 por POST', async () => {
    const f = fakeFetch();
    const d = rokuDriver('192.168.1.60', { fetchImpl: f.impl });
    await d.power(false);
    await d.volumeStep(-3);
    await d.launch?.('netflix');
    await d.key('ENTER');
    expect(f.calls).toEqual([
      'POST http://192.168.1.60:8060/keypress/PowerOff',
      'POST http://192.168.1.60:8060/keypress/VolumeDown',
      'POST http://192.168.1.60:8060/keypress/VolumeDown',
      'POST http://192.168.1.60:8060/keypress/VolumeDown',
      'POST http://192.168.1.60:8060/launch/12',
      'GET http://192.168.1.60:8060/query/active-app',
      'POST http://192.168.1.60:8060/keypress/Select',
    ]);
  });

  it('403 explica cómo permitir el control por red; nada fuera de la LAN', async () => {
    await expect(
      rokuDriver('192.168.1.60', { fetchImpl: fakeFetch(403).impl }).power(true),
    ).rejects.toThrow(/Acceso a la red/);
    await expect(
      rokuDriver('8.8.8.8', { fetchImpl: fakeFetch().impl }).power(true),
    ).rejects.toThrow(/IP LOCAL/);
  });

  it('device-info da nombre, modelo y serie', async () => {
    expect(await rokuDeviceInfo('192.168.1.60', { fetchImpl: fakeFetch().impl })).toEqual({
      name: 'Dormitorio',
      model: 'TCL 55R635',
      serial: 'X00400ABCDEF',
      isTv: true,
    });
  });

  it('lo que el protocolo no tiene se dice sin tocar la tele', async () => {
    const f = fakeFetch();
    const d = rokuDriver('192.168.1.60', { fetchImpl: f.impl });
    await expect(runIntentOnDriver(d, { action: 'volume', level: 20 })).rejects.toThrow(
      /volumen exacto/,
    );
    await expect(runIntentOnDriver(d, { action: 'channel', channel: '5' })).rejects.toThrow(
      /canal/,
    );
    expect(f.calls).toEqual([]);
    expect(await runIntentOnDriver(d, { action: 'mute', on: true })).toContain('alternado');
    // «sube 50» no son 50 pulsaciones.
    await runIntentOnDriver(d, { action: 'volumeStep', steps: 50 });
    expect(f.calls.filter((c) => c.endsWith('VolumeUp'))).toHaveLength(20);
  });
});

describe('Roku en el descubrimiento y en el registro', () => {
  it('SSDP roku:ecp se reconoce como Roku y no se sondea Glasshouse', async () => {
    expect(isRoku({ server: 'Roku/9.4.0 UPnP/1.0 Roku/9.4.0' })).toBe(true);
    expect(isRoku({ manufacturer: 'Sonos' })).toBe(false);
    const listeners: ((m: Buffer, r: { address: string }) => void)[] = [];
    const socket: UdpLike = {
      send: () => {
        for (const l of listeners)
          l(
            Buffer.from(
              'HTTP/1.1 200 OK\r\nST: roku:ecp\r\nLOCATION: http://192.168.1.60:8060/\r\nUSN: uuid:roku:ecp:X00400ABCDEF\r\nSERVER: Roku/9.4.0 UPnP/1.0 Roku/9.4.0\r\n\r\n',
            ),
            { address: '192.168.1.60' },
          );
      },
      on: (_e, cb) => listeners.push(cb),
      close: () => {},
    };
    const asked: string[] = [];
    const fetchImpl = (async (u: string) => {
      asked.push(String(u));
      return new Response(
        '<root><device><manufacturer>Roku</manufacturer><friendlyName>Dormitorio</friendlyName><modelName>TCL 55R635</modelName></device></root>',
      );
    }) as unknown as typeof fetch;
    const found = await discoverWebOsTvs({ socket, fetchImpl, waitMs: 500 });
    expect(found).toEqual([
      expect.objectContaining({ ip: '192.168.1.60', brand: 'roku', name: 'Dormitorio' }),
    ]);
    expect(asked).toEqual(['http://192.168.1.60:8060/']);
  });

  it('una entrada Roku sin clave sobrevive al parseo (las LG sin clave no)', () => {
    const list = parseRegistry(
      JSON.stringify([
        { host: '192.168.1.60', brand: 'roku', clientKey: '', secure: '1' },
        { host: '192.168.1.61', clientKey: '' },
      ]),
    );
    expect(list.map((t) => `${t.host}:${t.brand}`)).toEqual(['192.168.1.60:roku']);
  });
});

describe('pa tv setup-roku y órdenes a un Roku', () => {
  const salon = {
    host: '192.168.1.237',
    brand: 'lg',
    name: 'Salón',
    clientKey: 'k-salon',
    secure: '1',
  };
  let fetches: string[];
  beforeEach(() => {
    vault.clear();
    lgCalls.length = 0;
    fetches = [];
    vault.set('tv:host', salon.host);
    vault.set('tv:clientKey', salon.clientKey);
    vault.set('tv:secure', '1');
    vault.set('tv:tvs', JSON.stringify([salon]));
    vi.stubGlobal('fetch', (async (url: string | URL, init?: RequestInit) => {
      fetches.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(String(url).endsWith('/query/device-info') ? DEVICE_INFO : '');
    }) as unknown as typeof fetch);
  });
  afterEach(() => vi.unstubAllGlobals());
  const run = (text: string) =>
    createTvTool(tvToolDeps(new Store())).execute('t', { action: 'command', text } as never);

  it('setup-roku guarda el Roku con su nombre y deja la LG como activa', async () => {
    const lines: string[] = [];
    const out = (s: string) => void lines.push(s);
    expect(await tvCommand(['setup-roku', '192.168.1.60'], { out, err: out })).toBe(0);
    const reg = parseRegistry(vault.get('tv:tvs'));
    expect(reg.find((t) => t.host === '192.168.1.60')).toMatchObject({
      brand: 'roku',
      name: 'Dormitorio',
      model: 'TCL 55R635',
    });
    expect(vault.get('tv:host')).toBe('192.168.1.237');
    expect(vault.get('tv:clientKey')).toBe('k-salon');
    expect(lines.join('')).toContain('Dormitorio');
  });

  it('«baja el volumen de la tele del dormitorio» va al Roku por ECP y no toca la LG', async () => {
    await tvCommand(['setup-roku', '192.168.1.60'], { out: () => {}, err: () => {} });
    fetches.length = 0;
    const res = await run('baja el volumen de la tele del dormitorio');
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches.every((c) => c === 'POST http://192.168.1.60:8060/keypress/VolumeDown')).toBe(
      true,
    );
    expect(lgCalls).toEqual([]);
    expect(JSON.stringify(res.content)).toContain('Roku');
  });

  it('con el Roku activo, «apaga la tele» sin nombre lo apaga por ECP', async () => {
    await tvCommand(['setup-roku', '192.168.1.60'], { out: () => {}, err: () => {} });
    vault.set('tv:host', '192.168.1.60');
    vault.set('tv:activeBrand', 'roku');
    fetches.length = 0;
    await run('apaga la tele');
    expect(fetches).toEqual(['POST http://192.168.1.60:8060/keypress/PowerOff']);
    expect(lgCalls).toEqual([]);
  });
});
