import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { GlasshouseError, GlasshouseUnavailableError } from '../src/tv/glasshouse.js';
import { TvUnreachableError, tvRequest } from '../src/tv/lgtv.js';
import { tvPower, WOL_HINT } from '../src/tv/power.js';
import { macFromNetworkInfo } from '../src/tv/tv-cli.js';
import { magicPacket, parseMac, sendWakeOnLan, subnetBroadcast } from '../src/tv/wol.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.237';

describe('Wake-on-LAN', () => {
  it('normaliza la MAC en cualquier formato habitual', () => {
    expect(parseMac('A8:23:FE:01:02:03')).toBe('a8:23:fe:01:02:03');
    expect(parseMac('a8-23-fe-01-02-03')).toBe('a8:23:fe:01:02:03');
    expect(parseMac(' a823fe010203 ')).toBe('a8:23:fe:01:02:03');
    expect(() => parseMac('a8:23:fe:01:02')).toThrow(/AA:BB:CC:DD:EE:FF/);
    expect(() => parseMac('00:00:00:00:00:00')).toThrow(/no valida/);
    expect(() => parseMac('zz:23:fe:01:02:03')).toThrow(/no valida/);
  });

  it('paquete magico: 6 x FF + 16 x MAC = 102 bytes', () => {
    const p = magicPacket('a8:23:fe:01:02:03');
    expect(p.length).toBe(102);
    expect([...p.subarray(0, 6)]).toEqual([255, 255, 255, 255, 255, 255]);
    for (let i = 0; i < 16; i += 1) {
      expect([...p.subarray(6 + i * 6, 12 + i * 6)]).toEqual([0xa8, 0x23, 0xfe, 1, 2, 3]);
    }
  });

  it('va al broadcast global y al /24 de la tele, con repeticiones', async () => {
    const sent: string[] = [];
    const targets = await sendWakeOnLan('a8:23:fe:01:02:03', {
      host: HOST,
      send: async (packet, address, port) => {
        expect(packet.length).toBe(102);
        sent.push(`${address}:${port}`);
      },
    });
    expect(targets).toEqual(['255.255.255.255', '192.168.1.255']);
    expect(sent).toEqual([
      '255.255.255.255:9',
      '255.255.255.255:9',
      '255.255.255.255:9',
      '192.168.1.255:9',
      '192.168.1.255:9',
      '192.168.1.255:9',
    ]);
    expect(subnetBroadcast('tele.local')).toBeNull();
  });

  it('un destino que falla no invalida el resto; si fallan todos, error en castellano', async () => {
    const partial = await sendWakeOnLan('a8:23:fe:01:02:03', {
      host: HOST,
      repeat: 1,
      send: async (_p, address) => {
        if (address === '255.255.255.255') throw new Error('EACCES');
      },
    });
    expect(partial).toEqual(['192.168.1.255']);
    await expect(
      sendWakeOnLan('a8:23:fe:01:02:03', {
        repeat: 1,
        send: async () => {
          throw new Error('ENETUNREACH');
        },
      }),
    ).rejects.toThrow('No pude enviar el paquete de encendido por red: ENETUNREACH');
  });

  it('lee la MAC de connectionmanager/getinfo (cable primero, luego wifi)', () => {
    expect(
      macFromNetworkInfo({
        wiredInfo: { macAddress: 'A8:23:FE:00:00:01' },
        wifiInfo: { macAddress: 'a8:23:fe:00:00:02' },
      }),
    ).toBe('a8:23:fe:00:00:01');
    expect(
      macFromNetworkInfo({
        wiredInfo: { macAddress: '' },
        wifiInfo: { macAddress: 'a8:23:fe:00:00:02' },
      }),
    ).toBe('a8:23:fe:00:00:02');
    expect(macFromNetworkInfo({ returnValue: true })).toBeNull();
    expect(macFromNetworkInfo(null)).toBeNull();
  });
});

describe('reconexion SSAP', () => {
  it('ANTES fallaba: una tele que rechaza la primera conexion (recien despertada) ahora responde', async () => {
    const tv = new FakeWebOsTv({ failOpens: 1 });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'system/turnOff',
        {},
        { factory: tv.factory, connectRetryDelayMs: 1 },
      ),
    ).resolves.toEqual({ returnValue: true });
    expect(tv.urls).toEqual([`wss://${HOST}:3001`, `wss://${HOST}:3001`]);
    expect(tv.requests.map((r) => r.uri)).toEqual(['system/turnOff']);
    expect(tv.allClosed()).toBe(true);
  });

  it('connectRetries=0 conserva el comportamiento de un solo intento', async () => {
    const tv = new FakeWebOsTv({ failOpens: 1 });
    await expect(
      tvRequest(HOST, 'KEY123', 'system/turnOff', {}, { factory: tv.factory, connectRetries: 0 }),
    ).rejects.toBeInstanceOf(TvUnreachableError);
    expect(tv.urls).toHaveLength(1);
  });

  it('un timeout de apertura NO se reintenta (tele apagada: ya se espero)', async () => {
    const tv = new FakeWebOsTv({ reachable: false, openFailure: 'hang' });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'system/turnOff',
        {},
        {
          factory: tv.factory,
          connectTimeoutMs: 20,
          connectRetryDelayMs: 1,
        },
      ),
    ).rejects.toThrow(/timeout abriendo el canal seguro/);
    expect(tv.urls).toHaveLength(1);
  });

  it('un rechazo DESPUES de conectar nunca se reintenta (la orden pudo llegar)', async () => {
    const tv = new FakeWebOsTv({
      handlers: { 'system/turnOff': () => ({ returnValue: false, errorText: 'busy' }) },
    });
    await expect(
      tvRequest(HOST, 'KEY123', 'system/turnOff', {}, { factory: tv.factory }),
    ).rejects.toThrow(/La TV rechazo system\/turnOff: busy/);
    expect(tv.requests).toHaveLength(1);
    expect(tv.urls).toHaveLength(1);
  });
});

describe('tvPower (Glasshouse -> SSAP -> Wake-on-LAN)', () => {
  const unreachable = () =>
    new TvUnreachableError('No se pudo conectar con la TV en 192.168.1.237 (wss://3001).');

  it('Glasshouse responde: no toca SSAP ni WoL', async () => {
    const calls: string[] = [];
    const out = await tvPower(true, {
      gh: async (a) => void calls.push(`gh:${a}`),
      ssap: async (u) => void calls.push(`ssap:${u}`),
      wake: async () => void calls.push('wake'),
    });
    expect(out).toEqual({ via: 'glasshouse', verified: null });
    expect(calls).toEqual(['gh:powerOn']);
  });

  it('rechazo de Glasshouse (allowPower=false) se propaga sin probar otro transporte', async () => {
    const calls: string[] = [];
    await expect(
      tvPower(false, {
        gh: async () => {
          throw new GlasshouseError('La tele rechazo powerOff: power disabled.');
        },
        ssap: async (u) => void calls.push(`ssap:${u}`),
      }),
    ).rejects.toThrow(/power disabled/);
    expect(calls).toEqual([]);
  });

  it('Glasshouse inalcanzable: SSAP turnOnScreen / system/turnOff como siempre', async () => {
    const calls: string[] = [];
    const gh = async () => {
      throw new GlasshouseUnavailableError('sin conexion');
    };
    const ssap = async (u: string) => void calls.push(u);
    expect(await tvPower(true, { gh, ssap })).toEqual({ via: 'ssap', verified: null });
    expect(await tvPower(false, { gh, ssap })).toEqual({ via: 'ssap', verified: null });
    expect(calls).toEqual(['com.webos.service.tvpower/power/turnOnScreen', 'system/turnOff']);
  });

  it('ANTES "encender" con la tele apagada del todo solo fallaba; ahora WoL y espera a que responda', async () => {
    const calls: string[] = [];
    let probes = 0;
    const out = await tvPower(true, {
      gh: async () => {
        throw new GlasshouseUnavailableError('sin conexion');
      },
      ssap: async () => {
        throw unreachable();
      },
      wake: async () => void calls.push('wake'),
      probe: async () => {
        probes += 1;
        return probes >= 3;
      },
      sleep: async () => {},
      pollMs: 1000,
      wakeWaitMs: 10_000,
    });
    expect(out).toEqual({ via: 'wol', verified: true });
    expect(calls).toEqual(['wake']);
    expect(probes).toBe(3);
  });

  it('WoL enviado pero la tele no responde a tiempo: verified false (sin mentir)', async () => {
    let probes = 0;
    const out = await tvPower(true, {
      ssap: async () => {
        throw unreachable();
      },
      wake: async () => {},
      probe: async () => {
        probes += 1;
        return false;
      },
      sleep: async () => {},
      pollMs: 2000,
      wakeWaitMs: 6000,
    });
    expect(out).toEqual({ via: 'wol', verified: false });
    expect(probes).toBe(3);
  });

  it('sin MAC: el error de siempre mas la pista para activar el encendido por red', async () => {
    const err = await tvPower(true, {
      ssap: async () => {
        throw unreachable();
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TvUnreachableError);
    expect((err as Error).message).toContain('No se pudo conectar con la TV');
    expect((err as Error).message).toContain(WOL_HINT);
  });

  it('apagar nunca envia WoL; un rechazo SSAP (no conexion) tampoco lo dispara', async () => {
    const calls: string[] = [];
    const wake = async () => void calls.push('wake');
    await expect(
      tvPower(false, {
        ssap: async () => {
          throw unreachable();
        },
        wake,
      }),
    ).rejects.toBeInstanceOf(TvUnreachableError);
    await expect(
      tvPower(true, {
        ssap: async () => {
          throw new Error(
            'La TV rechazo com.webos.service.tvpower/power/turnOnScreen: not permitted',
          );
        },
        wake,
      }),
    ).rejects.toThrow(/not permitted/);
    expect(calls).toEqual([]);
  });
});

describe('tool tv power con Wake-on-LAN', () => {
  const base = (power: TvToolDeps['power']): TvToolDeps => ({
    shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'x', category: [] }),
    apps: async () => [],
    launch: async () => {},
    key: async () => {},
    toast: async () => {},
    power,
    saveFrame: () => '',
    getState: () => null,
    setState: () => {},
  });
  type R = { content: Array<{ text?: string }>; details: Record<string, unknown> };
  const run = (d: TvToolDeps) =>
    createTvTool(d).execute('id', { action: 'power', on: true } as never) as unknown as Promise<R>;

  it('dice que encendio solo cuando la tele responde', async () => {
    const ok = await run(base(async () => ({ via: 'wol', verified: true })));
    expect(ok.content[0]?.text).toMatch(/encendido por red .* y ya responde/);
    expect(ok.details).toEqual({ on: true, verified: true, via: 'wol' });
    const late = await run(base(async () => ({ via: 'wol', verified: false })));
    expect(late.content[0]?.text).toMatch(/aun no responde/);
    expect(late.details.verified).toBe(false);
  });

  it('por Glasshouse o SSAP, el texto de siempre', async () => {
    const r = await run(base(async () => ({ via: 'glasshouse', verified: null })));
    expect(r.content[0]?.text).toMatch(/^Orden de encender la pantalla enviada/);
    expect(r.details).toEqual({ on: true, verified: false });
  });
});
