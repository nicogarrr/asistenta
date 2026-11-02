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

import type { DiscoveredTv } from '../src/tv/discover.js';
import { withLegacyTv } from '../src/tv/registry.js';
import { tvCommand } from '../src/tv/tv-cli.js';

function io() {
  const lines: string[] = [];
  const { spyOn } = vi;
  spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    lines.push(String(c));
    return true;
  }) as never);
  spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
    lines.push(String(c));
    return true;
  }) as never);
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
});

describe('withLegacyTv', () => {
  it('añade la LG de las claves sueltas; no duplica la que ya está; sin clave no la inventa', () => {
    const added = withLegacyTv([], {
      host: '192.168.1.237',
      clientKey: 'k',
      secure: '1',
      mac: 'a8:23:fe:01:02:03',
    });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ host: '192.168.1.237', brand: 'lg', clientKey: 'k' });
    const ya = withLegacyTv(added, { host: '192.168.1.237', clientKey: 'k', secure: '1' });
    expect(ya).toHaveLength(1);
    expect(withLegacyTv([], { host: '192.168.1.237', clientKey: '', secure: '1' })).toHaveLength(0);
    expect(withLegacyTv([], { host: '  ' })).toHaveLength(0);
  });

  it('la Sony activa aparece aunque no tenga clientKey', () => {
    const added = withLegacyTv([], { host: '10.0.0.9', brand: 'sony' });
    expect(added[0]).toMatchObject({ host: '10.0.0.9', brand: 'sony' });
  });

  it('no muta la lista que recibe', () => {
    const base = withLegacyTv([], { host: '10.0.0.9', brand: 'sony' });
    withLegacyTv(base, { host: '192.168.1.237', clientKey: 'k', secure: '1' });
    expect(base).toHaveLength(1);
  });
});

describe('una sola tele de antes: migración sin escribir nada', () => {
  it('pa tv teles la lista como activa y el vault queda byte a byte igual', async () => {
    legacyOnly();
    const antes = new Map(vault);
    const o = io();
    expect(await tvCommand(['teles'], o)).toBe(0);
    expect(o.lines.join('')).toContain('(activa)');
    expect(o.lines.join('')).toContain('192.168.1.237');
    expect([...vault.entries()].sort()).toEqual([...antes.entries()].sort());
  });

  it('pa tv usar <ip de siempre> funciona y no cambia ninguna clave de la tele', async () => {
    legacyOnly();
    const o = io();
    expect(await tvCommand(['usar', '192.168.1.237'], o)).toBe(0);
    expect(vault.get('tv:host')).toBe('192.168.1.237');
    expect(vault.get('tv:clientKey')).toBe('k-salon');
    expect(o.lines.join('')).toContain('Tele activa');
  });

  it('tras setup-sony (que migra la LG al registro), usar va y viene entre las dos', async () => {
    // Estado tras emparejar la Sony: la LG ya migrada al registro y las
    // claves sueltas apuntando a la Sony (clientKey suelta ya no aplica).
    vault.clear();
    vault.set('tv:host', '10.0.0.9');
    vault.set('tv:activeBrand', 'sony');
    vault.set('tv:clientKey', 'k-salon');
    vault.set('tv:secure', '1');
    vault.set(
      'tv:tvs',
      JSON.stringify([
        { host: '192.168.1.237', brand: 'lg', clientKey: 'k-salon', secure: '1' },
        { host: '10.0.0.9', brand: 'sony', clientKey: '', secure: '1' },
      ]),
    );
    const o = io();
    expect(await tvCommand(['usar', '192.168.1.237'], o)).toBe(0);
    expect(vault.get('tv:activeBrand')).toBe('lg');
    expect(vault.get('tv:clientKey')).toBe('k-salon');
    expect(await tvCommand(['usar', '10.0.0.9'], o)).toBe(0);
    expect(vault.get('tv:activeBrand')).toBe('sony');
  });
});

describe('pa tv setup sin IP', () => {
  it('con una sola LG nueva en la red la empareja y guarda nombre, modelo y uuid', async () => {
    legacyOnly();
    const o = io();
    const discover = async () => [
      lg('192.168.1.237', { name: 'Salon', uuid: 'uuid-vieja' }), // la de siempre
      lg('192.168.1.41', { name: 'Cuarto', model: 'OLED55C2', uuid: 'uuid-nueva' }),
    ];
    expect(await tvCommand(['setup'], { ...o, discover })).toBe(0);
    expect(paired).toEqual(['192.168.1.41']);
    const reg = JSON.parse(vault.get('tv:tvs') ?? '[]') as Record<string, unknown>[];
    const nueva = reg.find((t) => t.host === '192.168.1.41');
    expect(nueva).toMatchObject({ name: 'Cuarto', model: 'OLED55C2', uuid: 'uuid-nueva' });
    // Y la tele de antes queda migrada al registro (esto sí es momento de escritura).
    expect(reg.some((t) => t.host === '192.168.1.237' && t.clientKey === 'k-salon')).toBe(true);
  });

  it('con varias nuevas las lista y no empareja ninguna', async () => {
    legacyOnly();
    const o = io();
    const discover = async () => [lg('192.168.1.41'), lg('192.168.1.42', { name: 'Cuarto' })];
    expect(await tvCommand(['setup'], { ...o, discover })).toBe(2);
    expect(paired).toEqual([]);
    expect(o.lines.join('')).toContain('pa tv setup 192.168.1.41');
    expect(o.lines.join('')).toContain('pa tv setup 192.168.1.42');
  });

  it('si las que ve ya están emparejadas, lo dice', async () => {
    legacyOnly();
    const o = io();
    const discover = async () => [lg('192.168.1.237')];
    expect(await tvCommand(['setup'], { ...o, discover })).toBe(2);
    expect(paired).toEqual([]);
    expect(o.lines.join('')).toContain('ya están emparejadas');
  });

  it('ignora una Sony para el setup LG sin IP', async () => {
    legacyOnly();
    const o = io();
    const discover: () => Promise<DiscoveredTv[]> = async () => [
      { ip: '10.0.0.9', brand: 'sony', glasshouse: false },
    ];
    expect(await tvCommand(['setup'], { ...o, discover })).toBe(2);
    expect(paired).toEqual([]);
    expect(o.lines.join('')).toContain('No veo ninguna tele LG');
  });
});
