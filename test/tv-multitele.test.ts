import { describe, expect, it } from 'vitest';
import {
  BraviaError,
  braviaPowerStatus,
  braviaRequest,
  braviaSystemInfo,
  braviaVolume,
} from '../src/tv/bravia.js';
import {
  discoverWebOsTvs,
  isLgWebOsTv,
  isSonyBravia,
  parseSsdpResponse,
  type UdpLike,
  xmlTag,
} from '../src/tv/discover.js';
import { findTv, parseRegistry, registryToJson, upsertTv } from '../src/tv/registry.js';

describe('parseSsdpResponse / xmlTag / marcas', () => {
  it('parsea cabeceras HTTPU y devuelve null sin ellas', () => {
    const r = parseSsdpResponse(
      'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20:8080/dd.xml\r\nSERVER: WebOS/6.0 UPnP/1.0\r\nUSN: uuid:x\r\nST: upnp:rootdevice\r\n\r\n',
    );
    expect(r?.location).toBe('http://192.168.1.20:8080/dd.xml');
    expect(r?.server).toBe('WebOS/6.0 UPnP/1.0');
    expect(parseSsdpResponse('')).toBeNull();
    expect(parseSsdpResponse('sin dos puntos')).toBeNull();
  });

  it('reconoce LG webOS y Sony Bravia, y no se confunde con otro aparato', () => {
    expect(isLgWebOsTv({ server: 'WebOS/6.0 UPnP/1.0' })).toBe(true);
    expect(isLgWebOsTv({ manufacturer: 'LG Electronics', friendlyName: '[LG] webOS TV C1' })).toBe(
      true,
    );
    expect(isLgWebOsTv({ manufacturer: 'Sonos', modelName: 'Beam' })).toBe(false);
    expect(isSonyBravia({ st: 'urn:schemas-sony-com:service:ScalarWebAPI:1' })).toBe(true);
    expect(isSonyBravia({ manufacturer: 'Sony Corporation', modelName: 'BRAVIA XR-55' })).toBe(
      true,
    );
    expect(isSonyBravia({ manufacturer: 'Sonos', modelName: 'Beam' })).toBe(false);
    expect(xmlTag('<a><friendlyName> Salon </friendlyName></a>', 'friendlyName')).toBe('Salon');
    expect(xmlTag('<a/>', 'friendlyName')).toBeUndefined();
  });
});

describe('discoverWebOsTvs (socket y fetch falsos)', () => {
  function fakeSocket(answers: { from: string; body: string }[]): UdpLike {
    const listeners: ((msg: Buffer, rinfo: { address: string }) => void)[] = [];
    return {
      send: () => {
        for (const l of listeners)
          for (const a of answers) l(Buffer.from(a.body), { address: a.from });
      },
      on: (_e, cb) => listeners.push(cb),
      close: () => {},
    };
  }
  const xml = (manufacturer: string, friendly: string, model: string) =>
    `<root><device><manufacturer>${manufacturer}</manufacturer><friendlyName>${friendly}</friendlyName><modelName>${model}</modelName></device></root>`;

  it('junta respuestas, filtra a LG/Sony y sondea Glasshouse solo en LG', async () => {
    const socket = fakeSocket([
      {
        from: '192.168.1.20',
        body: 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20/dd.xml\r\nSERVER: WebOS/6.0\r\n\r\n',
      },
      {
        from: '192.168.1.30',
        body: 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.30/dd.xml\r\nST: urn:schemas-sony-com:service:ScalarWebAPI:1\r\n\r\n',
      },
      {
        from: '192.168.1.40',
        body: 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.40/dd.xml\r\n\r\n',
      },
    ]);
    const fetchImpl = (async (url: string) => {
      if (url.endsWith('/dd.xml')) {
        if (url.includes('1.20'))
          return new Response(xml('LG Electronics', '[LG] webOS TV C1', 'OLED55C1'));
        if (url.includes('1.30'))
          return new Response(xml('Sony Corporation', 'BRAVIA Salon', 'XR-55X90J'));
        return new Response(xml('Sonos', 'Beam', 'Beam'));
      }
      if (url.includes(':8080/api/caps') && url.includes('1.20'))
        return new Response('{}', { status: 200 });
      throw new Error('sin glasshouse');
    }) as never;
    const tvs = await discoverWebOsTvs({ socket, fetchImpl, waitMs: 600 });
    expect(tvs.map((t) => t.ip)).toEqual(['192.168.1.20', '192.168.1.30']);
    expect(tvs[0]).toMatchObject({
      brand: 'lg',
      name: '[LG] webOS TV C1',
      model: 'OLED55C1',
      glasshouse: true,
    });
    expect(tvs[1]).toMatchObject({ brand: 'sony', name: 'BRAVIA Salon', glasshouse: false });
  });
});

describe('registro de teles', () => {
  const lg = {
    host: '192.168.1.20',
    brand: 'lg' as const,
    clientKey: 'k',
    secure: '1' as const,
    name: 'Salon',
  };
  const sony = {
    host: '192.168.1.30',
    brand: 'sony' as const,
    clientKey: '',
    secure: '1' as const,
    model: 'XR-55',
  };

  it('las entradas viejas sin brand son LG; la Sony no necesita clientKey', () => {
    const list = parseRegistry(JSON.stringify([lg, sony]));
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.host === lg.host)?.brand).toBe('lg');
    expect(list.find((t) => t.host === sony.host)?.brand).toBe('sony');
  });

  it('descarta LG sin clave, basura y JSON roto', () => {
    expect(parseRegistry('[{"host":"1.2.3.4"}]')).toEqual([]);
    expect(parseRegistry('no json')).toEqual([]);
    expect(parseRegistry('{}')).toEqual([]);
    expect(parseRegistry(undefined)).toEqual([]);
  });

  it('upsert sustituye por host y ordena; find por ip o nombre', () => {
    const list = upsertTv([lg], { ...lg, name: 'Nueva' });
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Nueva');
    const both = upsertTv(list, sony);
    expect(both.map((t) => t.host)).toEqual([lg.host, sony.host]);
    expect(findTv(both, '192.168.1.30')?.brand).toBe('sony');
    expect(findTv(both, 'nueva')?.host).toBe(lg.host);
    expect(findTv(both, 'no esta')).toBeUndefined();
    expect(parseRegistry(registryToJson(both))).toEqual(both);
  });
});

describe('cliente Bravia (fetch falso)', () => {
  const ok = (result: unknown) =>
    (async () => new Response(JSON.stringify({ result, id: 1 }))) as never;

  it('peticion bien formada con X-Auth-PSK y resultado parseado', async () => {
    let seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const fetchImpl = (async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      seen = { url, headers: init.headers, body: init.body };
      return new Response(JSON.stringify({ result: [{ status: 'active' }], id: 1 }));
    }) as never;
    expect(await braviaPowerStatus('10.0.0.9', 'secreto', { fetchImpl })).toBe('active');
    expect(seen.url).toBe('http://10.0.0.9/sony/system');
    expect(seen.headers?.['X-Auth-PSK']).toBe('secreto');
    expect(JSON.parse(seen.body ?? '{}')).toMatchObject({
      method: 'getPowerStatus',
      version: '1.0',
    });
  });

  it('volumen: elige el altavoz y lee mute/max', async () => {
    const fetchImpl = ok([
      [
        { target: 'headphone', volume: 3 },
        { target: 'speaker', volume: 21, mute: false, maxVolume: 100 },
      ],
    ]);
    expect(await braviaVolume('h', 'p', { fetchImpl })).toEqual({
      volume: 21,
      mute: false,
      maxVolume: 100,
    });
  });

  it('systemInfo para setup: nombre y modelo', async () => {
    const fetchImpl = ok([{ name: 'BRAVIA', model: 'XR-55X90J' }]);
    expect(await braviaSystemInfo('h', 'p', { fetchImpl })).toEqual({
      name: 'BRAVIA',
      model: 'XR-55X90J',
    });
  });

  it('401 dice clave rechazada; error de red dice no llego; error de API da el codigo', async () => {
    await expect(
      braviaRequest('h', 'p', 'system', 'getPowerStatus', [], {
        fetchImpl: (async () => new Response('no', { status: 401 })) as never,
      }),
    ).rejects.toThrow('rechazado la clave');
    await expect(
      braviaRequest('h', 'p', 'system', 'getPowerStatus', [], {
        fetchImpl: (async () => {
          throw new Error('ECONNREFUSED');
        }) as never,
      }),
    ).rejects.toThrow('No llego a la tele Sony');
    await expect(
      braviaRequest('h', 'p', 'system', 'getPowerStatus', [], {
        fetchImpl: (async () => new Response(JSON.stringify({ error: [404, 'no such'] }))) as never,
      }),
    ).rejects.toThrow('(404)');
  });

  it('ningun mensaje de error lleva la PSK', async () => {
    const psk = 'PSK-SECRETA-123';
    for (const fetchImpl of [
      (async () => new Response('x', { status: 403 })) as never,
      (async () => {
        throw new Error('boom');
      }) as never,
    ]) {
      try {
        await braviaRequest('h', psk, 'system', 'getPowerStatus', [], { fetchImpl });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(BraviaError);
        expect(String(err)).not.toContain(psk);
      }
    }
  });
});
