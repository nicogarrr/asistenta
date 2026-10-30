// `pa tv …`: si la tele se re-empareja (aviso aceptado), la client-key nueva
// se guarda en el vault, igual que en la tool tv. lgtv y vault simulados.
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
type D = { onNewClientKey?: (k: string) => Promise<void> };
vi.mock('../src/tv/lgtv.js', async (orig) => {
  const real = await orig<typeof import('../src/tv/lgtv.js')>();
  return {
    ...real,
    tvRequest: vi.fn(async (_h: string, _k: string, _u: string, _p: unknown, d: D) => {
      await d.onNewClientKey?.('NUEVA');
      return { returnValue: true, apps: [] };
    }),
    tvToast: vi.fn(async (_h: string, _k: string, _m: string, d: D) => {
      await d.onNewClientKey?.('NUEVA');
    }),
    tvKey: vi.fn(async (_h: string, _k: string, _n: string, d: D) => {
      await d.onNewClientKey?.('NUEVA');
    }),
  };
});

const { tvCommand } = await import('../src/tv/tv-cli.js');

describe('pa tv guarda la client-key nueva si la tele se re-empareja', () => {
  beforeEach(() => {
    vault.clear();
    vault.set('tv:host', '192.168.1.50');
    vault.set('tv:clientKey', 'VIEJA');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it.each([[['toast', 'hola']], [['launch', 'netflix']], [['off']], [['key', 'HOME']], [['apps']]])(
    'pa tv %j',
    async (args) => {
      await tvCommand(args);
      expect(vault.get('tv:clientKey')).toBe('NUEVA');
    },
  );

  it('sin re-emparejado la clave guardada no cambia', async () => {
    const lg = await import('../src/tv/lgtv.js');
    vi.mocked(lg.tvToast).mockImplementationOnce(async () => {});
    await tvCommand(['toast', 'hola']);
    expect(vault.get('tv:clientKey')).toBe('VIEJA');
  });
});
