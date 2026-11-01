import { describe, expect, it } from 'vitest';
import type { VaultOps } from '../src/credentials/store.js';
import { createAccountsTool, SIGNUP_VAULT_FAILED } from '../src/tools/accounts.js';

const RAW = "EBUSY: resource busy or locked, open 'C:\\Users\\nico\\AppData\\secrets.json'";
const fail = (): never => {
  throw new Error(RAW);
};
const broken: VaultOps = {
  get: async () => fail(),
  set: async () => fail(),
  delete: async () => fail(),
  list: async () => fail(),
};
const owner = async () => ({ name: 'Nico', email: 'nico@example.com' });

describe('pasos del registro con el gestor de contraseñas roto', () => {
  for (const action of ['preparar_registro', 'confirmar_registro', 'guardar', 'descartar']) {
    it(`${action}: una línea llana, sin el error en crudo`, async () => {
      const r = await createAccountsTool(broken, owner).execute('c', {
        action,
        sitio: 'wallapop.es',
        correo: 'nico@example.com',
      } as never);
      const t = JSON.stringify(r);
      expect(t).toContain(SIGNUP_VAULT_FAILED.slice(0, 40));
      expect(t).not.toMatch(/EBUSY|AppData|secrets\.json/);
    });
  }

  it('los avisos propios del registro siguen llegando tal cual', async () => {
    const empty: VaultOps = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => false,
      list: async () => [],
    };
    const r = await createAccountsTool(empty, owner).execute('c', {
      action: 'guardar',
      sitio: 'wallapop.es',
    } as never);
    expect(JSON.stringify(r)).toContain('No hay ningún registro pendiente para esa web.');
    const p = await createAccountsTool(empty, owner).execute('c', {
      action: 'preparar_registro',
      sitio: '???',
    } as never);
    expect(JSON.stringify(p)).toContain('No reconozco esa web');
  });
});
