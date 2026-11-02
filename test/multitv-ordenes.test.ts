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
const calls: string[] = [];
const unreachable = new Set<string>();
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  const hit = (host: string, key: string, what: string) => {
    calls.push(`${host}|${key}|${what}`);
    if (unreachable.has(host)) throw new real.TvUnreachableError(`No llego a la tele (${host})`);
  };
  return {
    ...real,
    tvRequest: async (host: string, key: string, uri: string) => {
      hit(host, key, uri);
      return { returnValue: true };
    },
    tvKey: async (host: string, key: string, name: string) => hit(host, key, `key:${name}`),
    tvToast: async (host: string, key: string) => hit(host, key, 'toast'),
  };
});
const ghEndpoints: string[][] = [];
vi.mock('../src/tv/glasshouse.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/glasshouse.js')>();
  class FakeGlasshouse {
    constructor(opts: { endpoints: string[] }) {
      ghEndpoints.push(opts.endpoints);
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
let discovered: Array<{ ip: string; brand: 'lg'; glasshouse: boolean }> = [];
vi.mock('../src/tv/discover.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/discover.js')>();
  return { ...real, discoverWebOsTvs: async () => discovered };
});
const ensureCalls: number[] = [];
vi.mock('../src/tv/auto-select.js', () => ({
  ensureActiveTv: async () => {
    ensureCalls.push(1);
    return {};
  },
}));
const macs = new Map<string, string>();
vi.mock('../src/tv/neighbor-mac.js', () => ({
  readNeighborMac: async (ip: string) => macs.get(ip) ?? null,
}));

import { Store } from '../src/db.js';
import { tvToolDeps } from '../src/plugins/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import type { KnownTv } from '../src/tv/registry.js';
import { extractTvTarget, withoutTvPlace } from '../src/tv/target.js';
import { isTvOrder } from '../src/tv/tv-chat-command.js';

const salon: KnownTv = {
  host: '192.168.1.237',
  brand: 'lg',
  name: 'Salón',
  clientKey: 'k-salon',
  secure: '1',
  mac: 'a8:23:fe:00:00:01',
};
const dormitorio: KnownTv = {
  host: '192.168.1.40',
  brand: 'lg',
  name: '[LG] webOS TV Dormitorio',
  clientKey: 'k-dorm',
  secure: '1',
  mac: 'a8:23:fe:00:00:02',
};

describe('extractTvTarget: a qué tele va la orden', () => {
  const two = [salon, dormitorio];
  it('reconoce el nombre en las formas de hablar de casa', () => {
    expect(extractTvTarget('baja el volumen de la tele del salón', two)).toEqual({
      text: 'baja el volumen de la tele',
      tv: salon,
    });
    expect(extractTvTarget('enciende la del dormitorio', two)).toEqual({
      text: 'enciende la tele',
      tv: dormitorio,
    });
    expect(extractTvTarget('pon Netflix en el dormitorio', two)).toEqual({
      text: 'pon Netflix',
      tv: dormitorio,
    });
    expect(extractTvTarget('Apaga la TELE DEL SALON, por favor', two)).toEqual({
      text: 'Apaga la tele, por favor',
      tv: salon,
    });
  });
  it('sin nombre, o con palabras que no son una tele, el texto no cambia', () => {
    for (const t of [
      'apaga la tele',
      'pon la imagen en cine',
      'volumen a 15',
      'abre youtube en el navegador',
    ]) {
      expect(extractTvTarget(t, two)).toEqual({ text: t });
    }
  });
  it('con varias teles: un sitio desconocido o dos teles en una orden preguntan', () => {
    expect(extractTvTarget('apaga la tele del garaje', two).ask).toContain('«garaje»');
    expect(extractTvTarget('apaga la tele del salón y la del dormitorio', two).ask).toContain(
      '¿A qué tele?',
    );
  });
  it('con una sola tele nada cambia: ni pregunta ni toca el texto', () => {
    const one = [{ ...salon, name: undefined } as KnownTv];
    expect(extractTvTarget('apaga la tele del garaje', one)).toEqual({
      text: 'apaga la tele del garaje',
    });
    expect(extractTvTarget('baja el volumen', [])).toEqual({ text: 'baja el volumen' });
  });
  it('«salón grande» gana a «salón» sin falsa ambigüedad', () => {
    const grande: KnownTv = { ...dormitorio, name: 'salón grande' };
    expect(extractTvTarget('apaga la tele del salón grande', [salon, grande]).tv).toBe(grande);
  });
  it('el /tv del chat acepta la orden con la tele nombrada', () => {
    expect(withoutTvPlace('baja el volumen de la tele del salón')).toBe(
      'baja el volumen de la tele',
    );
    expect(isTvOrder('enciende la del dormitorio')).toBe(true);
  });
});

describe('la tool con varias teles (cableado real, red falsa)', () => {
  beforeEach(() => {
    vault.clear();
    calls.length = 0;
    ghEndpoints.length = 0;
    unreachable.clear();
    discovered = [];
    macs.clear();
    ensureCalls.length = 0;
    vault.set('tv:host', salon.host);
    vault.set('tv:clientKey', salon.clientKey);
    vault.set('tv:secure', '1');
    vault.set('tv:mac', salon.mac ?? '');
    vault.set('tv:tvs', JSON.stringify([salon, dormitorio]));
  });
  const run = (text: string) =>
    createTvTool(tvToolDeps(new Store())).execute('t', { action: 'command', text } as never);

  it('«apaga la tele del dormitorio» va solo a la del dormitorio, con su clave', async () => {
    const before = JSON.stringify([...vault.entries()]);
    const res = await run('apaga la tele del dormitorio');
    expect(JSON.stringify(res.content)).toContain('tele: [LG] webOS TV Dormitorio');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith('192.168.1.40|k-dorm|'))).toBe(true);
    expect(ghEndpoints.flat().every((e) => e === 'http://192.168.1.40:8080')).toBe(true);
    expect(JSON.stringify([...vault.entries()])).toBe(before);
    // Una orden a otra tele nunca cambia la activa (auto-selección no se consulta).
    expect(ensureCalls).toEqual([]);
  });

  it('sin nombre sigue yendo a la activa, como siempre', async () => {
    await run('apaga la tele');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith('192.168.1.237|k-salon|'))).toBe(true);
  });

  it('un sitio desconocido pregunta y no toca ninguna tele', async () => {
    const res = await run('apaga la tele del garaje');
    expect(JSON.stringify(res.content)).toContain('garaje');
    expect(calls).toEqual([]);
  });

  it('si el router le cambió la IP, la reencuentra por MAC y reintenta una vez', async () => {
    unreachable.add('192.168.1.40');
    discovered = [{ ip: '192.168.1.41', brand: 'lg', glasshouse: false }];
    macs.set('192.168.1.41', 'A8-23-FE-00-00-02');
    await run('abre netflix en el dormitorio');
    expect(calls.some((c) => c.startsWith('192.168.1.41|k-dorm|'))).toBe(true);
    const reg = JSON.parse(vault.get('tv:tvs') ?? '[]') as KnownTv[];
    expect(reg.map((t) => t.host).sort()).toEqual(['192.168.1.237', '192.168.1.41']);
    // La activa no se movió: sus claves siguen igual.
    expect(vault.get('tv:host')).toBe('192.168.1.237');
  });
});
