import { describe, expect, it } from 'vitest';
import {
  approveSignup,
  discardSignup,
  finishSignup,
  prepareSignup,
} from '../src/credentials/signup.js';
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

describe('guardar / descartar con solo el nombre de la web', () => {
  it('«descarta lo de wallapop» borra el registro a medias de wallapop.es', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    expect(await discardSignup('wallapop', v)).toBe(true);
    expect([...v.m.keys()]).toEqual([]);
  });

  it('«ya está, guárdala» con el nombre a secas guarda la de wallapop.es', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await approveSignup('wallapop.es', me.email, v);
    const a = await finishSignup('Wallapop', v);
    expect(a.domain).toBe('wallapop.es');
    expect(a.status).toBe('activa');
  });

  it('si encajan dos, pregunta cuál y no toca nada', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await prepareSignup('wallapop.com', me, {}, v);
    await expect(discardSignup('wallapop', v)).rejects.toThrow(
      /wallapop\.es, wallapop\.com|wallapop\.com, wallapop\.es/,
    );
    expect([...v.m.keys()].length).toBe(6);
  });

  it('el sí (confirmar) sigue pidiendo el dominio exacto', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', me, {}, v);
    await expect(approveSignup('wallapop', me.email, v)).rejects.toThrow(/web exacta/);
  });

  it('un dominio distinto no se mezcla: es.wallapop.com no es wallapop.es', async () => {
    const v = memVault();
    await prepareSignup('es.wallapop.com', me, {}, v);
    expect(await discardSignup('wallapop.es', v)).toBe(false);
  });
});
