import { describe, expect, it } from 'vitest';
import { approveSignup, prepareSignup } from '../src/credentials/signup.js';
import type { VaultOps } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';

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
const ME = { name: 'Nico', email: 'nico@example.com' };

async function step(v: VaultOps, args: Record<string, unknown>): Promise<string> {
  const tool = createAccountsTool(v, async () => ME);
  const r = await tool.execute('t', args as never);
  return (r.content[0] as { text: string }).text;
}

describe('registro con el nombre a secas: pistas claras', () => {
  it('«descarta lo de wallapop» dice la web de verdad que ha descartado', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    const t = await step(v, { action: 'descartar', sitio: 'wallapop' });
    expect(t).toMatch(/registro a medias de wallapop\.es;/);
    expect([...v.m.keys()]).toEqual([]);
  });

  it('confirmar con el nombre a secas no aprueba, pero dice qué web exacta usar', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await expect(approveSignup('wallapop', ME.email, v)).rejects.toThrow(/sitio=wallapop\.es/);
    const meta = JSON.parse(v.m.get('cuenta:wallapop.es') ?? '{}') as Record<string, unknown>;
    expect(meta.approvedAt).toBeUndefined();
  });

  it('confirmar con un nombre que encaja en dos webs pregunta cuál y no aprueba ninguna', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await prepareSignup('es.wallapop.com', ME, {}, v);
    const t = await step(v, { action: 'confirmar_registro', sitio: 'wallapop', correo: ME.email });
    expect(t).toMatch(/dime cuál/);
    for (const d of ['wallapop.es', 'es.wallapop.com']) {
      const meta = JSON.parse(v.m.get(`cuenta:${d}`) ?? '{}') as Record<string, unknown>;
      expect(meta.approvedAt).toBeUndefined();
    }
  });

  it('confirmar con otro dominio exacto sigue sin mezclarse', async () => {
    const v = memVault();
    await prepareSignup('wallapop.es', ME, {}, v);
    await expect(approveSignup('wallapop.com', ME.email, v)).rejects.toThrow(
      /No hay ningún registro/,
    );
  });
});
