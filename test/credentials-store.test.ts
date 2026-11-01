import { describe, expect, it } from 'vitest';
import {
  deleteAccount,
  findAccounts,
  generatePassword,
  listAccounts,
  maskUser,
  revealPassword,
  saveAccount,
  type VaultOps,
} from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(): VaultOps & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => map.delete(k),
    list: async () => [...map.keys()],
  };
}

describe('generador de contraseñas', () => {
  it('fuerte por defecto: 24, con minúscula, mayúscula, cifra y símbolo, distintas', () => {
    const a = generatePassword();
    expect(a).toHaveLength(24);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[0-9]/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50);
  });
  it('nunca menos de 20, salvo que la web ponga un máximo menor', () => {
    expect(generatePassword({ length: 8 })).toHaveLength(20);
    expect(generatePassword({ maxLength: 16 })).toHaveLength(16);
  });
  it('respeta las reglas de la web: sin símbolos o solo los admitidos', () => {
    expect(generatePassword({ symbols: false })).toMatch(/^[A-Za-z0-9]+$/);
    expect(generatePassword({ allowedSymbols: '_-' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('gestor de contraseñas sobre el vault', () => {
  it('guarda con la convención site:<dominio>:… y lista sin contraseña', async () => {
    const v = memVault();
    const acc = await saveAccount(
      {
        site: 'https://www.Wallapop.es/login',
        username: 'nico@example.com',
        now: new Date('2026-10-31T00:00:00Z'),
      },
      v,
    );
    const pw = v.map.get('site:wallapop.es:password') ?? '';
    expect(pw.length).toBeGreaterThanOrEqual(20);
    expect(v.map.get('site:wallapop.es:username')).toBe('nico@example.com');
    expect(JSON.stringify(acc)).not.toContain(pw);
    const all = await listAccounts(v);
    expect(all.map((a) => a.domain)).toEqual(['wallapop.es']);
    expect(JSON.stringify(all)).not.toContain(pw);
    expect(await revealPassword('wallapop.es', v)).toBe(pw);
    expect((await findAccounts('Wallapop', v)).length).toBe(1);
    expect((await findAccounts('amazon', v)).length).toBe(0);
    expect(await deleteAccount('wallapop.es', v)).toBe(true);
    expect(v.map.size).toBe(0);
  });
  it('ve también las logins que ya estaban en el vault y no toca otras claves', async () => {
    const v = memVault();
    v.map.set('site:renfe.com:username', 'nico');
    v.map.set('site:renfe.com:password', 'X-secret-1');
    v.map.set('google:refreshToken', 'tok');
    const all = await listAccounts(v);
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('activa');
  });
  it('enmascara el correo', () => {
    expect(maskUser('nico@gmail.com')).toBe('n…@gmail.com');
  });
});

describe('herramienta «cuentas»', () => {
  it('lista y busca sin enseñar jamás la contraseña', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
    const pw = v.map.get('site:wallapop.es:password') ?? '';
    const tool = createAccountsTool(v);
    const run = async (args: Record<string, unknown>) => {
      const r = await tool.execute('t', args as never);
      return JSON.stringify(r);
    };
    const listed = await run({ action: 'listar' });
    expect(listed).toContain('wallapop.es');
    expect(listed).toContain('n…@gmail.com');
    const yes = await run({ action: 'buscar', sitio: 'Wallapop' });
    expect(yes).toContain('Sí');
    const no = await run({ action: 'buscar', sitio: 'amazon.es' });
    expect(no).toContain('No tengo');
    for (const out of [listed, yes, no]) expect(out).not.toContain(pw);
  });
});
