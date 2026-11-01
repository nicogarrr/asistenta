import { describe, expect, it } from 'vitest';
import { prepareSignup } from '../src/credentials/signup.js';
import type { VaultOps } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(): VaultOps & { keys: () => string[] } {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => m.delete(k),
    list: async () => [...m.keys()],
    keys: () => [...m.keys()],
  };
}
const me = { name: 'Nico', email: 'nico@example.com' };

describe('preparar_registro con solo el nombre de la web', () => {
  it('«wallapop» sin dominio: pregunta el dominio y no guarda nada', async () => {
    const v = memVault();
    const r = await createAccountsTool(v, async () => me).execute('c', {
      action: 'preparar_registro',
      sitio: 'Wallapop',
    } as never);
    const t = JSON.stringify(r);
    expect(t).toContain('dominio');
    expect(t).not.toContain('preparado');
    expect(v.keys()).toEqual([]);
  });

  it('con dominio sigue igual (www. fuera)', async () => {
    const v = memVault();
    const a = await prepareSignup('www.wallapop.es', me, {}, v);
    expect(a.domain).toBe('wallapop.es');
    expect(v.keys().some((k) => k === 'site:wallapop.es:password')).toBe(true);
  });
});
