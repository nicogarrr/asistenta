import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const paired: string[] = [];
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    pairTv: async (host: string) => {
      paired.push(host);
      return { clientKey: `key-${host}`, secure: true };
    },
    tvRequest: async () => ({}),
  };
});

import { type DiscoveredTv, discoverWebOsTvs, type UdpLike } from '../src/tv/discover.js';
import { findMovedTvs, findTv, normalizeTvName, withLegacyTv } from '../src/tv/registry.js';
import { tvCommand } from '../src/tv/tv-cli.js';

function io() {
  const lines: string[] = [];
  return { lines, out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s) };
}
const lg = (ip: string, extra: Partial<DiscoveredTv> = {}): DiscoveredTv => ({
  ip,
  brand: 'lg',
  glasshouse: false,
  ...extra,
});
/** La config de siempre: una sola LG emparejada antes de que existiera el registro. */
function legacyOnly(): void {
  vault.clear();
  vault.set('tv:host', '192.168.1.237');
  vault.set('tv:clientKey', 'k-salon');
  vault.set('tv:secure', '1');
  vault.set('tv:mac', 'a8:23:fe:01:02:03');
}

beforeEach(() => {
  paired.length = 0;
  legacyOnly();
});

describe('una sola tele de antes: migración sin escribir nada', () => {
  it('pa tv teles la lista como activa y el vault queda byte a byte igual', async () => {
    const before = JSON.stringify([...vault.entries()]);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await tvCommand(['teles'])).toBe(0);
      const printed = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(printed).toContain('(activa)');
      expect(printed).toContain('192.168.1.237');
      expect(printed).not.toContain('No hay teles');
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify([...vault.entries()])).toBe(before);
  });

  it('pa tv usar <ip de siempre> funciona y no cambia ninguna clave de la tele', async () => {
    const before = JSON.stringify([...vault.entries()].sort());
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await tvCommand(['usar', '192.168.1.237'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    // Solo marca la marca activa (lg, la de siempre); host, clave, cifrado y MAC iguales.
    vault.delete('tv:activeBrand');
    expect(JSON.stringify([...vault.entries()].sort())).toBe(before);
  });

  it('withLegacyTv no duplica la que ya está en el registro', () => {
    const list = [
      { host: '192.168.1.237', brand: 'lg' as const, clientKey: 'x', secure: '1' as const },
    ];
    expect(withLegacyTv(list, { host: '192.168.1.237', clientKey: 'y' })).toHaveLength(1);
    expect(withLegacyTv([], {})).toEqual([]);
    expect(withLegacyTv([], { host: '192.168.1.5' })).toEqual([]);
  });
});

describe('pa tv nombre y nombres sin tildes', () => {
  it('pone nombre a la tele de antes y la encuentra como «salon» o «Salón»', async () => {
    const o = io();
    expect(await tvCommand(['nombre', '192.168.1.237', 'Salón'], o)).toBe(0);
    const reg = JSON.parse(vault.get('tv:tvs') ?? '[]') as Array<{
      host: string;
      name?: string;
      clientKey: string;
      mac?: string;
    }>;
    expect(reg).toEqual([
      expect.objectContaining({
        host: '192.168.1.237',
        name: 'Salón',
        clientKey: 'k-salon',
        mac: 'a8:23:fe:01:02:03',
      }),
    ]);
    expect(findTv(reg as never, 'salon')?.host).toBe('192.168.1.237');
    expect(normalizeTvName('[LG] webOS  TV Dormitorio')).toBe('webos tv dormitorio');
    // Las claves sueltas de la activa no se tocan.
    expect(vault.get('tv:host')).toBe('192.168.1.237');
  });

  it('rechaza nombres vacíos, IPs, repetidos y teles desconocidas', async () => {
    expect(await tvCommand(['nombre', '192.168.1.237'], io())).toBe(2);
    expect(await tvCommand(['nombre', '192.168.1.237', '10.0.0.1'], io())).toBe(2);
    expect(await tvCommand(['nombre', '192.168.1.99', 'cocina'], io())).toBe(1);
  });
});

describe('pa tv setup sin IP', () => {
  it('con una sola LG nueva en la red la empareja y guarda nombre, modelo y uuid', async () => {
    const o = io();
    const discover = async () => [
      lg('192.168.1.237'),
      lg('192.168.1.40', { name: '[LG] webOS TV Dormitorio', model: '43UP75', uuid: 'abc-123' }),
    ];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await tvCommand(['setup'], { ...o, discover })).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(paired).toEqual(['192.168.1.40']);
    const reg = JSON.parse(vault.get('tv:tvs') ?? '[]') as Array<Record<string, string>>;
    expect(reg.find((t) => t.host === '192.168.1.40')).toMatchObject({
      name: '[LG] webOS TV Dormitorio',
      model: '43UP75',
      uuid: 'abc-123',
      clientKey: 'key-192.168.1.40',
    });
  });

  it('con varias, las lista y no empareja ninguna; sin ninguna, lo dice', async () => {
    const o = io();
    const two = async () => [lg('192.168.1.40'), lg('192.168.1.41')];
    expect(await tvCommand(['setup'], { ...o, discover: two })).toBe(2);
    expect(o.lines.join('')).toContain('pa tv setup 192.168.1.41');
    expect(paired).toEqual([]);
    const n = io();
    expect(await tvCommand(['setup'], { ...n, discover: async () => [] })).toBe(2);
    expect(n.lines.join('')).toContain('No veo ninguna tele LG');
  });
});

describe('IP cambiada por el router (DHCP)', () => {
  it('pa tv buscar reencuentra la tele por su MAC y actualiza la activa', async () => {
    const o = io();
    const discover = async () => [lg('192.168.1.50')];
    const neighborMac = async (ip: string) => (ip === '192.168.1.50' ? 'A8-23-FE-01-02-03' : null);
    expect(await tvCommand(['buscar'], { ...o, discover, neighborMac })).toBe(0);
    expect(o.lines.join('')).toContain('192.168.1.237 → 192.168.1.50');
    expect(vault.get('tv:host')).toBe('192.168.1.50');
    const reg = JSON.parse(vault.get('tv:tvs') ?? '[]') as Array<{ host: string }>;
    expect(reg.map((t) => t.host)).toEqual(['192.168.1.50']);
  });

  it('si sigue en su IP o la MAC no coincide, no toca nada', async () => {
    const before = JSON.stringify([...vault.entries()].sort());
    const neighborMac = async () => 'ff:ee:dd:cc:bb:aa';
    expect(
      await tvCommand(['buscar'], {
        ...io(),
        discover: async () => [lg('192.168.1.50')],
        neighborMac,
      }),
    ).toBe(0);
    expect(
      await tvCommand(['buscar'], {
        ...io(),
        discover: async () => [lg('192.168.1.237'), lg('192.168.1.50')],
        neighborMac: async () => 'a8:23:fe:01:02:03',
      }),
    ).toBe(0);
    expect(JSON.stringify([...vault.entries()].sort())).toBe(before);
  });

  it('findMovedTvs reconoce por UUID y no pisa la IP de otra tele guardada', () => {
    const known = [
      {
        host: '192.168.1.10',
        brand: 'lg' as const,
        clientKey: 'a',
        secure: '1' as const,
        uuid: 'U-1',
      },
      {
        host: '192.168.1.11',
        brand: 'lg' as const,
        clientKey: 'b',
        secure: '1' as const,
        mac: 'aa:aa:aa:aa:aa:aa',
      },
    ];
    expect(findMovedTvs(known, [{ ip: '192.168.1.20', uuid: 'u-1' }])).toEqual([
      { tv: known[0], from: '192.168.1.10', to: '192.168.1.20' },
    ]);
    expect(findMovedTvs(known, [{ ip: '192.168.1.10', mac: 'aa:aa:aa:aa:aa:aa' }])).toEqual([]);
  });
});

describe('descubrimiento: solo la red local y el XML del propio aparato', () => {
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
  it('ignora IPs públicas, no sigue un LOCATION a otra máquina y saca el uuid', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      return new Response(
        '<root><manufacturer>LG Electronics</manufacturer><friendlyName>[LG] webOS TV</friendlyName></root>',
      );
    }) as unknown as typeof fetch;
    const body = (loc: string) =>
      `HTTP/1.1 200 OK\r\nLOCATION: ${loc}\r\nSERVER: WebOS/6.0 UPnP/1.0\r\nUSN: uuid:ABCD-1234-ef::urn:lge-com:service:webos-second-screen:1\r\n\r\n`;
    const found = await discoverWebOsTvs({
      socket: fakeSocket([
        { from: '192.168.1.20', body: body('http://192.168.1.20:1876/dd.xml') },
        { from: '192.168.1.21', body: body('http://203.0.113.9/dd.xml') },
        { from: '8.8.8.8', body: body('http://8.8.8.8/dd.xml') },
      ]),
      fetchImpl,
      waitMs: 500,
      probeGlasshouse: false,
    });
    expect(found.map((t) => t.ip)).toEqual(['192.168.1.20', '192.168.1.21']);
    expect(found[0]?.uuid).toBe('abcd-1234-ef');
    expect(asked).toEqual(['http://192.168.1.20:1876/dd.xml']);
  });
});
