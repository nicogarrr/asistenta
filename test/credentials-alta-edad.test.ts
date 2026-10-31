import { describe, expect, it } from 'vitest';
import { cuentasCommand } from '../src/credentials/export.js';
import { prepareSignup } from '../src/credentials/signup.js';
import { metaKey, type VaultOps } from '../src/credentials/store.js';
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
const DAY = 86_400_000;

/** Un alta a medias empezada hace `days` días. */
async function pendingFrom(v: ReturnType<typeof memVault>, site: string, days: number) {
  await prepareSignup(site, ME, {}, v);
  const meta = JSON.parse(v.m.get(metaKey(site)) ?? '{}') as Record<string, unknown>;
  meta.created = new Date(Date.now() - days * DAY - 60_000).toISOString();
  v.m.set(metaKey(site), JSON.stringify(meta));
}

async function listar(v: VaultOps): Promise<string> {
  const tool = createAccountsTool(v, async () => ME);
  const r = await tool.execute('t', { action: 'listar' } as never);
  return (r.content[0] as { text: string }).text;
}

describe('altas a medias: cuánto llevan así', () => {
  it('listar dice desde cuándo está a medias', async () => {
    const v = memVault();
    await pendingFrom(v, 'wallapop.es', 3);
    expect(await listar(v)).toMatch(/sin terminar, de hace 3 días/);
  });

  it('una de hace más de una semana: ofrece descartarla, pero no la borra', async () => {
    const v = memVault();
    await pendingFrom(v, 'wallapop.es', 12);
    const before = [...v.m.keys()].sort();
    const text = await listar(v);
    expect(text).toMatch(/de hace 12 días/);
    expect(text).toMatch(/«descarta lo de wallapop\.es»/);
    expect([...v.m.keys()].sort()).toEqual(before);
  });

  it('una reciente no trae oferta de descartar', async () => {
    const v = memVault();
    await pendingFrom(v, 'wallapop.es', 0);
    const text = await listar(v);
    expect(text).toMatch(/sin terminar, de hoy/);
    expect(text).not.toMatch(/descarta/);
  });

  it('buscar una web con alta a medias también dice la edad', async () => {
    const v = memVault();
    await pendingFrom(v, 'wallapop.es', 1);
    const tool = createAccountsTool(v, async () => ME);
    const r = await tool.execute('t', { action: 'buscar', sitio: 'wallapop.es' } as never);
    expect((r.content[0] as { text: string }).text).toMatch(/alta sin terminar, de ayer/);
  });

  it('`pa cuentas listar` enseña la edad y la oferta, sin borrar nada', async () => {
    const v = memVault();
    await pendingFrom(v, 'wallapop.es', 10);
    await pendingFrom(v, 'vinted.es', 2);
    const lines: string[] = [];
    const rc = await cuentasCommand(['listar'], { vault: v, out: (s) => lines.push(s) });
    expect(rc).toBe(0);
    const all = lines.join('\n');
    expect(all).toMatch(/wallapop\.es .*\(sin terminar, de hace 10 días\)/);
    expect(all).toMatch(/vinted\.es .*\(sin terminar, de hace 2 días\)/);
    expect(all).toMatch(/pídeme en el chat «descarta lo de wallapop\.es»/);
    expect(all).not.toMatch(/vinted\.es» y la quito/);
    expect([...v.m.keys()].filter((k) => k.startsWith('cuenta:')).length).toBe(2);
  });
});
