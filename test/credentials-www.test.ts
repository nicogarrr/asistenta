import { describe, expect, it } from 'vitest';
import { prepareSignup } from '../src/credentials/signup.js';
import {
  deleteAccount,
  findAccounts,
  listAccounts,
  revealPassword,
  type VaultOps,
} from '../src/credentials/store.js';

function memVault(entries: Record<string, string>): VaultOps & { m: Map<string, string> } {
  const m = new Map(Object.entries(entries));
  return {
    m,
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => m.delete(k),
    list: async () => [...m.keys()],
  };
}

const WWW = {
  'site:www.wallapop.es:username': 'nico@example.com',
  'site:www.wallapop.es:password': 'pw-www',
  'cuenta:www.wallapop.es': JSON.stringify({ created: '2026-01-02T10:00:00Z', status: 'activa' }),
};
const ME = { name: 'Nico', email: 'nico@example.com' };

describe('cuentas guardadas con www (pa vault set site:www.…): una sola web', () => {
  it('«¿qué cuentas tengo?» la lista como wallapop.es, una vez', async () => {
    const v = memVault({
      ...WWW,
      'site:wallapop.es:username': 'n@x.es',
      'site:wallapop.es:password': 'p',
    });
    const all = await listAccounts(v);
    expect(all.map((a) => a.domain)).toEqual(['wallapop.es']);
    expect((await listAccounts(memVault(WWW)))[0]).toMatchObject({
      domain: 'wallapop.es',
      username: 'nico@example.com',
    });
    expect(await findAccounts('www.wallapop.es', v)).toHaveLength(1);
  });

  it('no prepara un alta nueva si ya tienes la cuenta guardada con www', async () => {
    const v = memVault(WWW);
    await expect(prepareSignup('wallapop.es', ME, {}, v)).rejects.toThrow(/Ya tienes cuenta/);
    expect(v.m.has('site:wallapop.es:password')).toBe(false);
  });

  it('copiar y borrar la encuentran por wallapop.es', async () => {
    const v = memVault(WWW);
    expect(await revealPassword('wallapop.es', v)).toBe('pw-www');
    expect(await deleteAccount('https://wallapop.es/login', v)).toBe(true);
    expect([...v.m.keys()]).toEqual([]);
  });

  it('una clave con mayúsculas cuenta como la misma web', async () => {
    const v = memVault({ 'site:Wallapop.ES:password': 'p', 'site:Wallapop.ES:username': 'u' });
    expect((await listAccounts(v)).map((a) => a.domain)).toEqual(['wallapop.es']);
  });
});
