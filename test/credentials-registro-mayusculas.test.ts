import { describe, expect, it } from 'vitest';
import { approveSignup, prepareSignup } from '../src/credentials/signup.js';
import type { VaultOps } from '../src/credentials/store.js';

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

describe('confirmar_registro y las mayúsculas del correo', () => {
  it('«nico@gmail.com» vale para el registro preparado con «Nico@Gmail.com»', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', { name: 'Nico', email: 'Nico@Gmail.com' }, {}, v);
    const a = await approveSignup('wallapop.es', ' nico@gmail.com ', v);
    expect(a.domain).toBe('wallapop.es');
  });

  it('otro correo sigue sin valer', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', { name: 'Nico', email: 'nico@gmail.com' }, {}, v);
    await expect(approveSignup('wallapop.es', 'otro@gmail.com', v)).rejects.toThrow(
      /no es el del registro/,
    );
  });
});
