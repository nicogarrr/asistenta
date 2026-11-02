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
import { tvCommand } from '../src/tv/tv-cli.js';

function io() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    lines.push(String(c));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => {
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

describe('migración en la primera escritura real', () => {
  // (donde usa el mismo registro efectivo por dentro: loadKnownTvs)
  it('al emparejar otra LG, la de antes queda migrada al registro (con su clave)', async () => {
    legacyOnly();
    const o = io();
    const discover = async () => [
      lg('192.168.1.237', { name: 'Salon', uuid: 'uuid-vieja' }),
      lg('192.168.1.41', { name: 'Cuarto', model: 'OLED55C2', uuid: 'uuid-nueva' }),
    ];
    expect(await tvCommand(['setup'], { ...o, discover })).toBe(0);
    expect(paired).toEqual(['192.168.1.41']);
    const reg = JSON.parse(vault.get('tv:tvs') ?? '[]') as Record<string, unknown>[];
    expect(reg.find((t) => t.host === '192.168.1.41')).toMatchObject({
      name: 'Cuarto',
      model: 'OLED55C2',
      uuid: 'uuid-nueva',
    });
    // La tele pre-registro no se pierde: migrada con su clientKey.
    expect(reg.some((t) => t.host === '192.168.1.237' && t.clientKey === 'k-salon')).toBe(true);
  });

  it('tras migrar, pa tv usar va y viene entre la tele de antes y la nueva', async () => {
    legacyOnly();
    const o = io();
    const discover = async () => [lg('192.168.1.41', { name: 'Cuarto' })];
    expect(await tvCommand(['setup'], { ...o, discover })).toBe(0);
    expect(vault.get('tv:host')).toBe('192.168.1.41');
    // Volver a la de siempre sin re-emparejar (clave desde el registro migrado).
    expect(await tvCommand(['usar', '192.168.1.237'], o)).toBe(0);
    expect(vault.get('tv:host')).toBe('192.168.1.237');
    expect(vault.get('tv:clientKey')).toBe('k-salon');
    expect(vault.get('tv:activeBrand')).toBe('lg');
    expect(await tvCommand(['usar', '192.168.1.41'], o)).toBe(0);
    expect(vault.get('tv:host')).toBe('192.168.1.41');
    expect(vault.get('tv:clientKey')).toBe('key-192.168.1.41');
  });

});
