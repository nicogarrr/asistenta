import { describe, expect, it } from 'vitest';
import { approveSignup, discardSignup, prepareSignup } from '../src/credentials/signup.js';
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
const USER = 'site:wallapop.es:username';

describe('preparar otra vez no pisa la contraseña de un alta que puede existir', () => {
  it('con otro correo: no cambia nada y pide descartar antes', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    const first = v.m.get(PW);
    await expect(
      prepareSignup('wallapop.es', { name: 'Nico', email: 'otro@example.com' }, {}, v),
    ).rejects.toThrow(/otro correo.*desc[aá]rt/is);
    expect(v.m.get(PW)).toBe(first);
    expect(v.m.get(USER)).toBe(me.email);
  });

  it('el mismo correo con otras mayúsculas es el mismo buzón: conserva la contraseña', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    const first = v.m.get(PW);
    await prepareSignup('wallapop.es', { name: 'Nico', email: 'Nico@Example.com' }, {}, v);
    expect(v.m.get(PW)).toBe(first);
  });

  it('ya aprobado y con reglas nuevas: no la cambia sin preguntar', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await approveSignup('wallapop.es', me.email, v);
    const first = v.m.get(PW);
    await expect(prepareSignup('wallapop.es', me, { maxLength: 12 }, v)).rejects.toThrow(
      /wallapop\.es.*aprobaste.*desc[aá]rt/is,
    );
    expect(v.m.get(PW)).toBe(first);
    expect(JSON.parse(v.m.get('cuenta:wallapop.es') ?? '{}').approvedAt).toBeTypeOf('number');
  });

  it('ya aprobado y con otro correo: tampoco', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await approveSignup('wallapop.es', me.email, v);
    const first = v.m.get(PW);
    await expect(
      prepareSignup('wallapop.es', { name: 'Nico', email: 'otro@example.com' }, {}, v),
    ).rejects.toThrow(/desc[aá]rt/i);
    expect(v.m.get(PW)).toBe(first);
  });

  it('tras descartar (el dueño dijo que la web no lo creó) se puede preparar de nuevo', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await approveSignup('wallapop.es', me.email, v);
    const first = v.m.get(PW);
    expect(await discardSignup('wallapop.es', v)).toBe(true);
    await prepareSignup('wallapop.es', me, { maxLength: 12 }, v);
    expect(v.m.get(PW)).not.toBe(first);
    expect((v.m.get(PW) ?? '').length).toBeLessThanOrEqual(12);
  });

  it('sin aprobar, con el mismo correo y reglas nuevas, sigue generando otra', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    const first = v.m.get(PW);
    await prepareSignup('wallapop.es', me, { maxLength: 12 }, v);
    expect(v.m.get(PW)).not.toBe(first);
  });
});
