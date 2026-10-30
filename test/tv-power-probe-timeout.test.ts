// Sondeo de encendido tras el Wake-on-LAN: cada intento de conexion espera
// como mucho 2 s (antes 5 s por defecto), para que «enciende la tele» no se
// alargue con la tele aun dormida. Nada sale a la red: vault, lgtv, WoL y
// Glasshouse estan simulados.
import { describe, expect, it, vi } from 'vitest';

const vault = new Map<string, string>([
  ['tv:host', '192.168.1.50'],
  ['tv:clientKey', 'KEY'],
  ['tv:mac', 'AA:BB:CC:DD:EE:FF'],
]);
vi.mock('../src/vault.js', () => ({
  vaultGet: async (k: string) => vault.get(k),
  vaultSet: async (k: string, v: string) => {
    vault.set(k, v);
  },
}));

const calls: Array<{ uri: string; deps: Record<string, unknown> }> = [];
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    tvRequest: vi.fn(
      async (_h: string, _k: string, uri: string, _p: unknown, deps: Record<string, unknown>) => {
        calls.push({ uri, deps });
        if (uri.endsWith('turnOnScreen')) throw new real.TvUnreachableError('apagada');
        return { returnValue: true, state: 'Active' };
      },
    ),
  };
});
vi.mock('../src/tv/wol.js', () => ({ sendWakeOnLan: vi.fn(async () => {}) }));
vi.mock('../src/tv/glasshouse.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/glasshouse.js')>();
  class FakeGh {
    async control(): Promise<never> {
      throw new real.GlasshouseUnavailableError('sin glasshouse');
    }
  }
  return { ...real, GlasshouseClient: FakeGh };
});

const { Store } = await import('../src/db.js');
const { tvToolDeps } = await import('../src/plugins/tv.js');

describe('sondeo de encendido tras el WoL', () => {
  it('cada sondeo abre la conexion con un tope de 2 s y sin reintentos', async () => {
    const deps = tvToolDeps(new Store());
    const out = await deps.power(true);
    expect(out).toMatchObject({ via: 'wol', verified: true });
    const probe = calls.find((c) => c.uri.endsWith('getPowerState'));
    expect(probe?.deps.connectTimeoutMs).toBe(2_000);
    expect(probe?.deps.connectRetries).toBe(0);
  }, 10_000);
});
