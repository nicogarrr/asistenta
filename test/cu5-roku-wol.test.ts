/**
 * Roku apagado del todo con MAC conocida: Wake-on-LAN como la Samsung
 * (asis-computeruse-5, pista 2 de cu4/HANDOFF.md). Antes `pa tv setup-roku`
 * no guardaba la MAC y «abre Netflix» con el Roku apagado contestaba «No llego
 * al Roku»; había que encenderlo a mano y repetir. Todo con fakes.
 */
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
const wakes: string[] = [];
vi.mock('../src/tv/wol.js', async (orig) => ({
  ...(await orig<typeof import('../src/tv/wol.js')>()),
  sendWakeOnLan: async (mac: string, o?: { host?: string }) => {
    wakes.push(`${mac}@${o?.host ?? ''}`);
    return [];
  },
}));
vi.mock('../src/tv/auto-select.js', async (orig) => ({
  ...(await orig<typeof import('../src/tv/auto-select.js')>()),
  ensureActiveTv: async () => ({}),
}));

import { Store } from '../src/db.js';
import { tvToolDeps } from '../src/plugins/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { runIntentWaking } from '../src/tv/drivers.js';
import { parseRegistry } from '../src/tv/registry.js';
import { RokuUnreachableError, rokuDeviceInfo, rokuDriver } from '../src/tv/roku.js';
import { tvCommand } from '../src/tv/tv-cli.js';

const HOST = '192.168.1.60';
const info = (net: string, extra = '') =>
  `<device-info><serial-number>X00400ABCDEF</serial-number><model-name>TCL 55R635</model-name><user-device-name>Dormitorio</user-device-name><is-tv>true</is-tv><network-type>${net}</network-type><wifi-mac>D8:31:34:AA:BB:01</wifi-mac><ethernet-mac>d8:31:34:aa:bb:02</ethernet-mac>${extra}</device-info>`;

/** Roku de mentira: `off` = no contesta (como apagado del todo) hasta que llega el paquete mágico. */
function fakeRoku(opts: { off?: boolean; bootCalls?: number; xml?: string } = {}) {
  const calls: string[] = [];
  let off = opts.off ?? false;
  let boot = opts.bootCalls ?? 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (off || boot > 0) {
      if (!off) boot--;
      throw new TypeError('fetch failed');
    }
    calls.push(`${init?.method ?? 'GET'} ${u.replace(`http://${HOST}:8060`, '')}`);
    return new Response(u.endsWith('/query/device-info') ? (opts.xml ?? info('wifi')) : '');
  }) as unknown as typeof fetch;
  const wake = vi.fn(async () => {
    off = false;
  });
  return { calls, fetchImpl, wake };
}
const noSleep = { sleep: async () => {} };

describe('setup-roku guarda la MAC de /query/device-info', () => {
  it('la de la red por la que contesta: wifi o cable; sin MAC válida, nada', async () => {
    expect((await rokuDeviceInfo(HOST, { fetchImpl: fakeRoku().fetchImpl })).mac).toBe(
      'd8:31:34:aa:bb:01',
    );
    const eth = fakeRoku({ xml: info('ethernet') });
    expect((await rokuDeviceInfo(HOST, { fetchImpl: eth.fetchImpl })).mac).toBe(
      'd8:31:34:aa:bb:02',
    );
    const none = fakeRoku({
      xml: '<device-info><is-tv>true</is-tv><wifi-mac>00:00:00:00:00:00</wifi-mac></device-info>',
    });
    expect((await rokuDeviceInfo(HOST, { fetchImpl: none.fetchImpl })).mac).toBeUndefined();
  });
});

describe('driver Roku: encender por red', () => {
  it('apagado del todo + «abre Netflix» → paquete mágico y la orden en una vez', async () => {
    const r = fakeRoku({ off: true });
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, mac: 'd8:31:34:aa:bb:01', wake: r.wake });
    const said = await runIntentWaking(d, { action: 'launch', appId: 'netflix' }, noSleep);
    expect(r.wake).toHaveBeenCalledWith('d8:31:34:aa:bb:01', HOST);
    expect(r.calls).toEqual(['POST /keypress/PowerOn', 'POST /launch/12']);
    expect(said).toMatch(/apagada del todo: la he encendido por red/);
    expect(said).toMatch(/Roku: abriendo netflix/);
  });

  it('tarda en arrancar: reintenta hasta que contesta (tope de arranque)', async () => {
    const r = fakeRoku({ off: true });
    let wakeSent = false;
    let fails = 3;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (!wakeSent || fails-- > 0) throw new TypeError('fetch failed');
      return r.fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const wake = vi.fn(async () => {
      wakeSent = true;
      await r.wake();
    });
    const d = rokuDriver(HOST, { fetchImpl, mac: 'd8:31:34:aa:bb:01', wake });
    const said = await runIntentWaking(
      d,
      { action: 'search', text: 'dune', appId: 'netflix' },
      noSleep,
    );
    expect(wake).toHaveBeenCalledTimes(1);
    expect(r.calls.at(-1)).toContain('/search/browse?keyword=dune');
    expect(said).toMatch(/encendido por red/);
  });

  it('sin MAC: el «No llego al Roku» de siempre, sin paquete', async () => {
    const r = fakeRoku({ off: true });
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, wake: r.wake });
    await expect(
      runIntentWaking(d, { action: 'launch', appId: 'netflix' }, noSleep),
    ).rejects.toThrow(/No llego al Roku/);
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('volumen o apagar nunca lo encienden; un 403 no es «apagado»', async () => {
    const r = fakeRoku({ off: true });
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, mac: 'd8:31:34:aa:bb:01', wake: r.wake });
    await expect(runIntentWaking(d, { action: 'volumeStep', steps: 2 }, noSleep)).rejects.toThrow(
      RokuUnreachableError,
    );
    await expect(runIntentWaking(d, { action: 'power', on: false }, noSleep)).rejects.toThrow(
      /No llego/,
    );
    expect(r.wake).not.toHaveBeenCalled();
    const denied = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    const d403 = rokuDriver(HOST, { fetchImpl: denied, mac: 'd8:31:34:aa:bb:01', wake: r.wake });
    await expect(
      runIntentWaking(d403, { action: 'launch', appId: 'netflix' }, noSleep),
    ).rejects.toThrow(/Acceso a la red/);
    expect(r.wake).not.toHaveBeenCalled();
  });

  it('«enciende la tele» con MAC: paquete y PowerOn; si aún arranca no falla', async () => {
    const r = fakeRoku({ off: true });
    const offForGood = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const d = rokuDriver(HOST, { fetchImpl: offForGood, mac: 'd8:31:34:aa:bb:01', wake: r.wake });
    await expect(d.power(true)).resolves.toBeUndefined();
    expect(r.wake).toHaveBeenCalledTimes(1);
  });
});

describe('cableado: pa tv setup-roku + orden por el nombre', () => {
  beforeEach(() => {
    vault.clear();
    wakes.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('guarda la MAC y «abre netflix en la tele del dormitorio» con el Roku apagado lo enciende', async () => {
    let on = true;
    const fetches: string[] = [];
    vi.stubGlobal('fetch', (async (url: string | URL, init?: RequestInit) => {
      if (!on) throw new TypeError('fetch failed');
      fetches.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(String(url).endsWith('/query/device-info') ? info('wifi') : '');
    }) as unknown as typeof fetch);
    const lines: string[] = [];
    expect(
      await tvCommand(['setup-roku', HOST], { out: (s) => void lines.push(s), err: () => {} }),
    ).toBe(0);
    expect(parseRegistry(vault.get('tv:tvs')).find((t) => t.host === HOST)).toMatchObject({
      brand: 'roku',
      mac: 'd8:31:34:aa:bb:01',
    });
    expect(lines.join('')).not.toContain('sin MAC');
    // Apagado del todo: no contesta hasta que sale el paquete mágico.
    on = false;
    fetches.length = 0;
    const realLen = wakes.length;
    const wol = await import('../src/tv/wol.js');
    const spy = vi.spyOn(wol, 'sendWakeOnLan');
    spy.mockImplementation(async (mac, o) => {
      wakes.push(`${mac}@${o?.host ?? ''}`);
      on = true;
      return [];
    });
    const res = await createTvTool(tvToolDeps(new Store())).execute('t', {
      action: 'command',
      text: 'abre netflix en la tele del dormitorio',
    } as never);
    expect(wakes.slice(realLen)).toEqual([`d8:31:34:aa:bb:01@${HOST}`]);
    expect(fetches).toContain(`POST http://${HOST}:8060/launch/12`);
    expect(JSON.stringify(res.content)).toMatch(/encendido por red/);
    spy.mockRestore();
  }, 15_000);

  it('sin MAC en device-info lo dice al guardar', async () => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(
          '<device-info><user-device-name>Cocina</user-device-name><is-tv>true</is-tv></device-info>',
        )) as unknown as typeof fetch,
    );
    const lines: string[] = [];
    await tvCommand(['setup-roku', '192.168.1.61'], {
      out: (s) => void lines.push(s),
      err: () => {},
    });
    expect(lines.join('')).toContain('sin MAC: no podré encenderlo por red');
  });
});
