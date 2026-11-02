// Orden de resolución de la clave de OpenCode Go: una OPENCODE_GO_API_KEY
// puesta a propósito en el .env manda sobre una provider:apiKey vieja del
// almacén (bloqueo de Nico, 2-nov-2026: una clave vieja guardada daba 401 y
// la env nueva quedaba tapada).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/vault.js', () => ({
  vaultGet: vi.fn(async (key: string) => {
    if (key === 'provider:apiKey') return 'CLAVE-VIEJA-DEL-ALMACEN';
    return null;
  }),
}));

const GO_URL = 'https://opencode.ai/zen/go/v1';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OPENCODE_GO_API_KEY;
  vi.resetModules();
});

afterEach(() => {
  if (saved === undefined) delete process.env.OPENCODE_GO_API_KEY;
  else process.env.OPENCODE_GO_API_KEY = saved;
});

describe('resolveApiKey con OpenCode Go', () => {
  it('la env OPENCODE_GO_API_KEY manda sobre la clave vieja del almacén', async () => {
    process.env.OPENCODE_GO_API_KEY = 'CLAVE-NUEVA-DEL-ENV';
    const { resolveApiKey } = await import('../src/core/provider.js');
    await expect(resolveApiKey(GO_URL)).resolves.toBe('CLAVE-NUEVA-DEL-ENV');
  });

  it('sin env usa la del almacén (comportamiento de siempre)', async () => {
    delete process.env.OPENCODE_GO_API_KEY;
    const { resolveApiKey } = await import('../src/core/provider.js');
    await expect(resolveApiKey(GO_URL)).resolves.toBe('CLAVE-VIEJA-DEL-ALMACEN');
  });
});
