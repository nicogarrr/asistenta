import { describe, expect, it, vi } from 'vitest';

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

import { isSamsungTv } from '../src/tv/discover.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { parseRegistry } from '../src/tv/registry.js';
import {
  type SamsungSocket,
  samsungDeviceInfo,
  samsungDriver,
  samsungSend,
  samsungUrl,
} from '../src/tv/samsung.js';
import { tvCommand } from '../src/tv/tv-cli.js';

/** Tele Samsung falsa: contesta ms.channel.connect (con token) o unauthorized. */
function fakeTv(opts: { token?: string; deny?: boolean; silent?: boolean } = {}) {
  const urls: string[] = [];
  const sent: string[] = [];
  const factory = (url: string): SamsungSocket => {
    urls.push(url);
    const handlers: Record<string, ((x?: unknown) => void)[]> = {};
    const sock = {
      on: (ev: string, cb: (x?: unknown) => void) => {
        const list = handlers[ev] ?? [];
        list.push(cb);
        handlers[ev] = list;
      },
      send: (d: string) => void sent.push(d),
      close: () => {},
    } as unknown as SamsungSocket;
    if (!opts.silent) {
      setTimeout(() => {
        const msg = opts.deny
          ? { event: 'ms.channel.unauthorized' }
          : { event: 'ms.channel.connect', data: opts.token ? { token: opts.token } : {} };
        for (const cb of handlers.message ?? []) cb(JSON.stringify(msg));
      }, 5);
    }
    return sock;
  };
  return { urls, sent, factory };
}
const keysOf = (sent: string[]) =>
  sent
    .map(
      (s) =>
        (JSON.parse(s) as { params: { DataOfCmd?: string; data?: { appId?: string } } }).params,
    )
    .map((p) => p.DataOfCmd ?? `app:${p.data?.appId}`);

describe('driver Samsung (WebSocket falso)', () => {
  it('URL: wss 8002 con token, ws 8001 sin él; nada fuera de la LAN', () => {
    expect(samsungUrl({ host: '192.168.1.70', token: 'abc123', secure: true })).toBe(
      'wss://192.168.1.70:8002/api/v2/channels/samsung.remote.control?name=QXNpc3RlbnRh&token=abc123',
    );
    expect(samsungUrl({ host: '192.168.1.70', secure: false })).toBe(
      'ws://192.168.1.70:8001/api/v2/channels/samsung.remote.control?name=QXNpc3RlbnRh',
    );
    expect(() => samsungUrl({ host: '8.8.8.8', secure: true })).toThrow(/IP LOCAL/);
  });

  it('volumen por pasos, apagar y abrir Netflix mandan las teclas de Tizen', async () => {
    const tv = fakeTv({ token: 'abc123' });
    const d = samsungDriver(
      { host: '192.168.1.70', token: 'abc123', secure: true },
      { socketFactory: tv.factory, graceMs: 0 },
    );
    await d.volumeStep(-2);
    await d.power(false);
    await d.launch?.('netflix');
    expect(keysOf(tv.sent)).toEqual([
      'KEY_VOLDOWN',
      'KEY_VOLDOWN',
      'KEY_POWER',
      'app:3201907018807',
    ]);
  });

  it('encender es Wake-on-LAN con su MAC (apagada no hay WebSocket)', async () => {
    const woken: string[] = [];
    const d = samsungDriver(
      { host: '192.168.1.70', secure: true },
      { mac: 'aa:bb:cc:dd:ee:ff', wake: async (mac, host) => void woken.push(`${mac}@${host}`) },
    );
    await d.power(true);
    expect(woken).toEqual(['aa:bb:cc:dd:ee:ff@192.168.1.70']);
    await expect(samsungDriver({ host: '192.168.1.70', secure: true }).power(true)).rejects.toThrow(
      /MAC/,
    );
  });

  it('token nuevo se avisa para guardarlo; rechazo y silencio dan errores claros', async () => {
    const saved: string[] = [];
    await samsungSend({ host: '192.168.1.70', secure: true }, [], {
      socketFactory: fakeTv({ token: 'nuevo9' }).factory,
      onToken: (t) => void saved.push(t),
      graceMs: 0,
    });
    expect(saved).toEqual(['nuevo9']);
    await expect(
      samsungSend({ host: '192.168.1.70', secure: true }, [], {
        socketFactory: fakeTv({ deny: true }).factory,
        graceMs: 0,
      }),
    ).rejects.toThrow(/rechazado/);
    await expect(
      samsungSend({ host: '192.168.1.70', secure: true }, [], {
        socketFactory: fakeTv({ silent: true }).factory,
        connectTimeoutMs: 50,
        graceMs: 0,
      }),
    ).rejects.toThrow(/no contestó/);
  });

  it('volumen exacto no existe: lo dice sin mandar nada', async () => {
    const tv = fakeTv({ token: 't' });
    const d = samsungDriver(
      { host: '192.168.1.70', token: 't', secure: true },
      { socketFactory: tv.factory, graceMs: 0 },
    );
    await expect(runIntentOnDriver(d, { action: 'volume', level: 10 })).rejects.toThrow(
      /volumen exacto/,
    );
    expect(tv.urls).toEqual([]);
  });
});

describe('Samsung en el descubrimiento, el registro y pa tv setup-samsung', () => {
  it('reconoce teles Samsung y no móviles o barras', () => {
    expect(
      isSamsungTv({
        manufacturer: 'Samsung Electronics',
        friendlyName: '[TV] Samsung Q60 Series (55)',
      }),
    ).toBe(true);
    expect(isSamsungTv({ manufacturer: 'Samsung Electronics', modelName: 'QE55Q60AAU' })).toBe(
      true,
    );
    expect(
      isSamsungTv({
        manufacturer: 'Samsung Electronics',
        friendlyName: 'Galaxy S23',
        modelName: 'SM-S911B',
      }),
    ).toBe(false);
    expect(isSamsungTv({ manufacturer: 'LG Electronics', friendlyName: '[TV] algo' })).toBe(false);
  });

  it('device-info da nombre, modelo, MAC y si usa token', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          device: {
            name: '[TV] Cocina',
            modelName: 'UE43TU7105',
            wifiMac: 'AA:BB:CC:DD:EE:FF',
            TokenAuthSupport: 'true',
          },
        }),
      )) as unknown as typeof fetch;
    expect(await samsungDeviceInfo('192.168.1.70', { fetchImpl })).toEqual({
      name: '[TV] Cocina',
      model: 'UE43TU7105',
      mac: 'aa:bb:cc:dd:ee:ff',
      tokenAuth: true,
    });
  });

  it('setup-samsung empareja, guarda el token en su entrada y no toca la LG activa', async () => {
    vault.clear();
    vault.set('tv:host', '192.168.1.237');
    vault.set('tv:clientKey', 'k-salon');
    vault.set('tv:secure', '1');
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          device: {
            name: '[TV] Cocina',
            modelName: 'UE43TU7105',
            wifiMac: 'aa:bb:cc:dd:ee:ff',
            TokenAuthSupport: 'true',
          },
        }),
      )) as unknown as typeof fetch;
    const lines: string[] = [];
    const out = (s: string) => void lines.push(s);
    const tv = fakeTv({ token: 'tok42' });
    expect(
      await tvCommand(['setup-samsung', '192.168.1.70'], {
        out,
        err: out,
        samsung: { fetchImpl, socketFactory: tv.factory, graceMs: 0 },
      }),
    ).toBe(0);
    const reg = parseRegistry(vault.get('tv:tvs'));
    expect(reg.find((t) => t.host === '192.168.1.70')).toMatchObject({
      brand: 'samsung',
      clientKey: 'tok42',
      secure: '1',
      mac: 'aa:bb:cc:dd:ee:ff',
      name: '[TV] Cocina',
    });
    expect(vault.get('tv:host')).toBe('192.168.1.237');
    expect(vault.get('tv:clientKey')).toBe('k-salon');
    expect(lines.join('')).toContain('ACEPTA el aviso');
  });

  it('pa tv usar hacia otra tele guarda antes la LG de antes en el registro', async () => {
    vault.clear();
    vault.set('tv:host', '192.168.1.237');
    vault.set('tv:clientKey', 'k-salon');
    vault.set('tv:secure', '1');
    vault.set(
      'tv:tvs',
      JSON.stringify([{ host: '192.168.1.70', brand: 'samsung', clientKey: 'tok42', secure: '1' }]),
    );
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await tvCommand(['usar', '192.168.1.70'])).toBe(0);
      expect(await tvCommand(['usar', '192.168.1.237'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(vault.get('tv:host')).toBe('192.168.1.237');
    expect(vault.get('tv:clientKey')).toBe('k-salon');
    expect(vault.get('tv:activeBrand')).toBe('lg');
  });
});
