import { describe, expect, it } from 'vitest';
import type { VaultOps } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(entries: Record<string, string>): VaultOps {
  const m = new Map(Object.entries(entries));
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => m.delete(k),
    list: async () => [...m.keys()],
  };
}

const V = memVault({
  'site:wallapop.es:username': 'nicogarrr',
  'site:wallapop.es:password': 'SECRETO-wallapop-123',
  'cuenta:wallapop.es': JSON.stringify({ created: '2026-03-04T10:00:00Z', status: 'activa' }),
  'site:amazon.es:username': 'nico@example.com',
  'site:amazon.es:password': 'SECRETO-amazon-456',
  'site:amazon.com:username': 'nico@example.com',
  'site:amazon.com:password': 'SECRETO-amazon-789',
});
const run = async (args: Record<string, unknown>) => {
  const r = await createAccountsTool(V, async () => null).execute('c', args as never);
  return JSON.stringify(r);
};

describe('«¿cuál es mi usuario en X?»', () => {
  it('buscar en una sola web da el usuario entero', async () => {
    const t = await run({ action: 'buscar', sitio: 'wallapop' });
    expect(t).toContain('nicogarrr');
    expect(t).toContain('wallapop.es');
  });

  it('nunca la contraseña, ni en buscar ni en listar', async () => {
    for (const args of [
      { action: 'buscar', sitio: 'wallapop.es' },
      { action: 'buscar', sitio: 'amazon' },
      { action: 'listar' },
    ]) {
      expect(await run(args)).not.toMatch(/SECRETO/);
    }
  });

  it('con varias webs, o al listar, el usuario sigue tapado', async () => {
    const varias = await run({ action: 'buscar', sitio: 'amazon' });
    expect(varias).toContain('amazon.es');
    expect(varias).toContain('amazon.com');
    expect(varias).not.toContain('nico@example.com');
    expect(await run({ action: 'listar' })).not.toContain('nicogarrr');
  });
});
