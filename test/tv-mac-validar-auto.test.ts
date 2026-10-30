import { beforeEach, describe, expect, it, vi } from 'vitest';

const vault = new Map<string, string>();
vi.mock('../src/vault.js', () => ({
  vaultGet: async (k: string) => vault.get(k) ?? null,
  vaultSetMany: async (o: Record<string, string>) => {
    for (const [k, v] of Object.entries(o)) vault.set(k, v);
  },
}));

const { tvCommand } = await import('../src/tv/tv-cli.js');
const { validateTvMac, magicPacket } = await import('../src/tv/wol.js');
const { macFromNeighborTable, readNeighborMac } = await import('../src/tv/neighbor-mac.js');

function io() {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, deps: { out: (s: string) => o.push(s), err: (s: string) => e.push(s) } };
}

beforeEach(() => vault.clear());

describe('pa tv mac: valida que sea la MAC de una tarjeta de red', () => {
  it('ANTES se guardaba el ID de app IPTV «69:e3:ed:6b:a4:4b»; ahora se rechaza (multicast) y no se guarda', async () => {
    const { e, deps } = io();
    expect(await tvCommand(['mac', '69:e3:ed:6b:a4:4b'], deps)).toBe(2);
    expect(vault.has('tv:mac')).toBe(false);
    expect(e.join('')).toMatch(/multicast/);
    expect(e.join('')).toMatch(/ID de una app/);
    expect(e.join('')).toMatch(/Ajustes > General > Acerca de este TV/);
    expect(e.join('')).toMatch(/router/);
  });

  it('una MAC normal se guarda sin aviso; una administrada localmente se guarda con aviso', async () => {
    let r = io();
    expect(await tvCommand(['mac', 'A4-4B-3E-12-34-56'], r.deps)).toBe(0);
    expect(vault.get('tv:mac')).toBe('a4:4b:3e:12:34:56');
    expect(r.e).toEqual([]);
    r = io();
    expect(await tvCommand(['mac', '6a:e3:ed:6b:a4:4b'], r.deps)).toBe(0);
    expect(vault.get('tv:mac')).toBe('6a:e3:ed:6b:a4:4b');
    expect(r.e.join('')).toMatch(/administrada localmente/);
  });

  it('todo ceros, broadcast y mal escrita se rechazan diciendo dónde está la real', () => {
    for (const bad of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '69:e3:ed', 'hola']) {
      expect(() => validateTvMac(bad)).toThrow(/Acerca de este TV/);
    }
  });

  it('el paquete mágico no cambia (sigue aceptando lo de antes)', () => {
    expect(magicPacket('a4:4b:3e:12:34:56').length).toBe(102);
  });
});

describe('pa tv mac auto: lee la MAC de la tabla de vecinos con la IP emparejada', () => {
  it('con IP emparejada lee la MAC, la valida, la enseña y la guarda', async () => {
    vault.set('tv:host', '192.168.1.40');
    const seen: string[] = [];
    const { o, deps } = io();
    const rc = await tvCommand(['mac', 'auto'], {
      ...deps,
      neighborMac: async (ip) => {
        seen.push(ip);
        return 'a4-4b-3e-12-34-56';
      },
    });
    expect(rc).toBe(0);
    expect(seen).toEqual(['192.168.1.40']);
    expect(vault.get('tv:mac')).toBe('a4:4b:3e:12:34:56');
    expect(o.join('')).toMatch(/a4:4b:3e:12:34:56 \(leída de la red\)/);
  });

  it('sin IP emparejada, con la tele apagada (sin entrada) o con una MAC multicast: error claro y no guarda', async () => {
    let r = io();
    expect(
      await tvCommand(['mac', 'auto'], { ...r.deps, neighborMac: async () => 'a4:4b:3e:12:34:56' }),
    ).toBe(2);
    expect(r.e.join('')).toMatch(/empareja primero/);
    vault.set('tv:host', '192.168.1.40');
    r = io();
    expect(await tvCommand(['mac', 'auto'], { ...r.deps, neighborMac: async () => null })).toBe(2);
    expect(r.e.join('')).toMatch(/¿Está encendida/);
    r = io();
    expect(
      await tvCommand(['mac', 'auto'], { ...r.deps, neighborMac: async () => '69:e3:ed:6b:a4:4b' }),
    ).toBe(2);
    expect(r.e.join('')).toMatch(/multicast/);
    expect(vault.has('tv:mac')).toBe(false);
  });

  it('una IP guardada que no es de la LAN no se usa', async () => {
    vault.set('tv:host', '8.8.8.8');
    const r = io();
    const probe = vi.fn(async () => 'a4:4b:3e:12:34:56');
    expect(await tvCommand(['mac', 'auto'], { ...r.deps, neighborMac: probe })).toBe(2);
    expect(probe).not.toHaveBeenCalled();
  });

  it('lee la tabla de Windows, Linux y macOS con ping antes y sin shell', async () => {
    const calls: string[] = [];
    const fake = (outs: Record<string, string>) => async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return outs[cmd] ?? '';
    };
    const win = await readNeighborMac(
      '192.168.1.40',
      fake({
        arp: '\r\nInterfaz: 192.168.1.10 --- 0x5\r\n  Dirección de Internet   Dirección física   Tipo\r\n  192.168.1.40          a4-4b-3e-12-34-56     dinámico\r\n',
      }),
      'win32',
    );
    expect(win).toBe('a4-4b-3e-12-34-56');
    expect(calls).toEqual(['ping -n 1 -w 1000 192.168.1.40', 'arp -a 192.168.1.40']);
    calls.length = 0;
    const lin = await readNeighborMac(
      '192.168.1.40',
      fake({ ip: '192.168.1.40 dev wlan0 lladdr a4:4b:3e:12:34:56 REACHABLE\n' }),
      'linux',
    );
    expect(lin).toBe('a4:4b:3e:12:34:56');
    expect(calls).toEqual(['ping -c 1 -W 1 192.168.1.40', 'ip neigh show 192.168.1.40']);
    expect(await readNeighborMac('192.168.1.40', fake({}), 'darwin')).toBeNull();
  });

  it('no confunde la IP con otra que la contiene (192.168.1.4 no es 192.168.1.40)', () => {
    expect(
      macFromNeighborTable('  192.168.1.40   a4-4b-3e-12-34-56  dinámico', '192.168.1.4'),
    ).toBeNull();
    expect(macFromNeighborTable('192.168.1.4 dev eth0 FAILED', '192.168.1.4')).toBeNull();
  });
});
