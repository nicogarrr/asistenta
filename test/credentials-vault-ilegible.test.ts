import { describe, expect, it } from 'vitest';
import type { VaultOps } from '../src/credentials/store.js';
import { createAccountsTool, VAULT_UNREADABLE } from '../src/tools/accounts.js';

const RAW = "EACCES: permission denied, open 'C:\\Users\\nico\\AppData\\secrets.json'";
const broken: VaultOps = {
  get: async () => {
    throw new Error(RAW);
  },
  set: async () => undefined,
  delete: async () => false,
  list: async () => {
    throw new Error(RAW);
  },
};

describe('gestor de contraseñas que no se puede leer', () => {
  for (const args of [{ action: 'listar' }, { action: 'buscar', sitio: 'wallapop' }]) {
    it(`${args.action}: una línea llana, sin el error en crudo`, async () => {
      const r = await createAccountsTool(broken, async () => null).execute('c', args as never);
      const t = JSON.stringify(r);
      expect(t).toContain(VAULT_UNREADABLE.slice(0, 40));
      expect(t).not.toMatch(/EACCES|AppData|secrets\.json/);
    });
  }
});
