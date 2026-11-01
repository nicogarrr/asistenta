import { describe, expect, it } from 'vitest';
import { cuentasCommand } from '../src/credentials/export.js';
import { prepareSignup } from '../src/credentials/signup.js';
import { listAccounts, saveAccount, type VaultOps } from '../src/credentials/store.js';

function memVault(): VaultOps {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => m.delete(k),
    list: async () => [...m.keys()],
  };
}
const ME = { name: 'Nico', email: 'nico@example.com' };

async function run(argv: string[], vault: VaultOps, typed = '') {
  const lines: string[] = [];
  const code = await cuentasCommand(argv, {
    vault,
    out: (s) => lines.push(s),
    ask: async () => typed,
  });
  return { code, text: lines.join('\n') };
}

describe('pa cuentas descartar: quitar un alta a medias desde la consola', () => {
  it('con el nombre a secas y la web exacta tecleada, la descarta', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const r = await run(['descartar', 'wallapop'], v, 'wallapop.es');
    expect(r.code).toBe(0);
    expect(r.text).toContain('Descartada el alta a medias de wallapop.es');
    expect(await listAccounts(v)).toEqual([]);
  });

  it('si no teclea la web exacta, no descarta nada', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const r = await run(['descartar', 'wallapop.es'], v, 'si');
    expect(r.code).toBe(1);
    expect(r.text).toContain('Cancelado');
    expect((await listAccounts(v)).length).toBe(1);
  });

  it('con dos webs parecidas pregunta cuál y no toca ninguna', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await prepareSignup('es.wallapop.com', ME, {}, v);
    const r = await run(['descartar', 'wallapop'], v, 'wallapop.es');
    expect(r.text).toMatch(/dime cuál/);
    expect((await listAccounts(v)).length).toBe(2);
  });

  it('nunca toca una cuenta ya terminada', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: ME.email, password: 'x1!Abcdefgh' }, v);
    const r = await run(['descartar', 'wallapop.es'], v, 'wallapop.es');
    expect(r.code).toBe(1);
    expect(r.text).toContain('pa cuentas borrar');
    expect((await listAccounts(v)).length).toBe(1);
  });
});
