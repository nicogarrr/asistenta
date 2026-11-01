import { describe, expect, it } from 'vitest';
import { type PreflightDeps, runPreflight } from '../src/preflight.js';

const GB = 1024 ** 3;

/** Un PC de Nico en el que todo está bien. Cada test rompe una cosa. */
function deps(
  over: Partial<PreflightDeps> = {},
  vault: Record<string, string> = {},
): PreflightDeps {
  const store: Record<string, string> = {
    'telegram:botToken': '123:abc',
    'telegram:allowedUserIds': '42',
    'tv:host': '192.168.1.50',
    ...vault,
  };
  return {
    nodeVersion: 'v24.3.0',
    platform: 'win32',
    vaultExists: () => true,
    unlock: async () => {},
    vaultGet: async (k) => store[k],
    checkTelegramToken: async () => {},
    checkProvider: async () => {},
    providerFailureMessage: () => 'Falta la clave del proveedor.',
    tvReachable: async () => true,
    desktopEnabled: () => true,
    computerUseEnabled: () => true,
    mailStatus: async () => ({ read: 'ok', send: 'ok' }),
    freeDiskBytes: async () => 20 * GB,
    ...over,
  };
}

const byId = async (d: PreflightDeps) =>
  Object.fromEntries((await runPreflight(d)).map((c) => [c.id, c]));

describe('pa iniciar: /ordenador off guardado', () => {
  it('con el apagado guardado, el PC sale como aviso y no como «activado»', async () => {
    const c = await byId(deps({ computerUseEnabled: () => true, computerOffSaved: () => true }));
    expect(c.pc?.status).toBe('aviso');
    expect(c.pc?.detail).toMatch(/lo apagaste desde Telegram/);
    expect(c.pc?.detail).not.toMatch(/activado/);
    expect(c.pc?.hint).toBe('En Telegram, toca /ordenador y dime «enciéndelo».');
  });

  it('sin apagado guardado sigue igual (ok)', async () => {
    const c = await byId(deps({ computerUseEnabled: () => true, computerOffSaved: () => false }));
    expect(c.pc?.status).toBe('ok');
  });

  it('si no se puede mirar el apagado guardado, aviso (nunca «activado» a ciegas)', async () => {
    const c = await byId(
      deps({
        computerUseEnabled: () => true,
        computerOffSaved: () => {
          throw new Error('EACCES');
        },
      }),
    );
    expect(c.pc?.status).toBe('aviso');
  });

  it('PA_COMPUTER_USE=0 manda: el detalle sigue diciendo el .env', async () => {
    const c = await byId(deps({ computerUseEnabled: () => false, computerOffSaved: () => true }));
    expect(c.pc?.detail).toMatch(/PA_COMPUTER_USE=0/);
  });
});
