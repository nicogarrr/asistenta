import { describe, expect, it } from 'vitest';
import { approveSignup, prepareSignup } from '../src/credentials/signup.js';
import type { VaultOps } from '../src/credentials/store.js';

function memVault(): VaultOps & { m: Map<string, string> } {
  const m = new Map<string, string>();
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
const me = { name: 'Nico', email: 'nico@example.com' };
const PW = 'site:wallapop.es:password';

describe('preparar_registro dos veces para la misma web', () => {
  it('sin reglas nuevas conserva la contraseña ya escrita en el formulario', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    const first = v.m.get(PW);
    await prepareSignup('wallapop.es', me, { symbols: undefined, maxLength: undefined }, v);
    expect(v.m.get(PW)).toBe(first);
  });

  it('el sí ya dado sigue valiendo si no cambia nada', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await approveSignup('wallapop.es', me.email, v);
    await prepareSignup('wallapop.es', me, {}, v);
    expect(JSON.parse(v.m.get('cuenta:wallapop.es') ?? '{}').approvedAt).toBeTypeOf('number');
  });

  it('con reglas nuevas (la web rechazó la contraseña) genera otra', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    const first = v.m.get(PW);
    await prepareSignup('wallapop.es', me, { maxLength: 12 }, v);
    expect(v.m.get(PW)).not.toBe(first);
    expect((v.m.get(PW) ?? '').length).toBeLessThanOrEqual(12);
  });

  it('ya aprobado, con reglas nuevas no la cambia: antes hay que descartar', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await approveSignup('wallapop.es', me.email, v);
    const first = v.m.get(PW);
    await expect(prepareSignup('wallapop.es', me, { maxLength: 12 }, v)).rejects.toThrow(
      /descárta/,
    );
    expect(v.m.get(PW)).toBe(first);
  });
});
