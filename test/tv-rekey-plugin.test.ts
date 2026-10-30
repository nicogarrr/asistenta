// Re-emparejado: la tool tv guarda la client-key nueva en el vault.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vault = new Map<string, string>();
vi.mock('../src/vault.js', () => ({
  vaultGet: async (k: string) => vault.get(k),
  vaultSet: async (k: string, v: string) => {
    vault.set(k, v);
  },
}));
// La tele «re-emparejada»: cada llamada SSAP entrega una clave nueva.
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    tvRequest: vi.fn(
      async (
        _h: string,
        _k: string,
        _u: string,
        _p: unknown,
        deps: { onNewClientKey?: (k: string) => Promise<void> },
      ) => {
        await deps.onNewClientKey?.('CLAVE-NUEVA');
        return { returnValue: true, appId: 'netflix', appCategory: [] };
      },
    ),
    tvKey: vi.fn(
      async (
        _h: string,
        _k: string,
        _n: string,
        deps: { onNewClientKey?: (k: string) => Promise<void> },
      ) => {
        await deps.onNewClientKey?.('CLAVE-TECLA');
      },
    ),
  };
});

const { Store } = await import('../src/db.js');
const { tvToolDeps } = await import('../src/plugins/tv.js');

describe('la tool tv guarda la client-key si la tele se re-empareja', () => {
  beforeEach(() => {
    vault.clear();
    vault.set('tv:host', '192.168.1.50');
    vault.set('tv:clientKey', 'VIEJA');
  });

  it('una orden SSAP (foreground) guarda la clave nueva en el vault', async () => {
    const deps = tvToolDeps(new Store());
    await deps.foreground();
    expect(vault.get('tv:clientKey')).toBe('CLAVE-NUEVA');
  });

  it('una tecla del mando tambien la guarda', async () => {
    const deps = tvToolDeps(new Store());
    await deps.key('HOME');
    expect(vault.get('tv:clientKey')).toBe('CLAVE-TECLA');
  });
});
