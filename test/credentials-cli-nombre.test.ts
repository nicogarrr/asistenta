import { describe, expect, it } from 'vitest';
import { cuentasCommand } from '../src/credentials/export.js';
import { saveAccount, type VaultOps } from '../src/credentials/store.js';

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

async function run(v: VaultOps, argv: string[], answers: string[] = []) {
  const outs: string[] = [];
  const copied: string[] = [];
  const rc = await cuentasCommand(argv, {
    vault: v,
    out: (s) => outs.push(s),
    ask: async () => answers.shift() ?? '',
    askHidden: async () => '',
    isTty: true,
    copy: async (s) => {
      copied.push(s);
    },
  });
  return { rc, out: outs.join('\n'), copied };
}

describe('pa cuentas con solo el nombre de la web', () => {
  it('`pa cuentas copiar wallapop` copia la de wallapop.es si es la única', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
    const r = await run(v, ['copiar', 'Wallapop']);
    expect(r.rc).toBe(0);
    expect(r.copied).toEqual([v.map.get('site:wallapop.es:password')]);
    expect(r.out).not.toContain(v.map.get('site:wallapop.es:password') ?? '§');
  });

  it('si encajan dos webs distintas, pide la exacta y no copia nada', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
    await saveAccount({ site: 'es.wallapop.com', username: 'nico@gmail.com' }, v);
    const r = await run(v, ['copiar', 'wallapop']);
    expect(r.rc).toBe(1);
    expect(r.copied).toEqual([]);
    expect(r.out).toMatch(/es\.wallapop\.com, wallapop\.es\. Escribe la web exacta/);
  });

  it('un dominio exacto no se mezcla con otro: wallapop.com no es wallapop.es', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
    const r = await run(v, ['copiar', 'wallapop.com']);
    expect(r.rc).toBe(1);
    expect(r.copied).toEqual([]);
  });

  it('`pa cuentas borrar wallapop` sigue pidiendo escribir el dominio exacto', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
    const no = await run(v, ['borrar', 'wallapop'], ['wallapop']);
    expect(no.rc).toBe(1);
    expect(v.map.has('site:wallapop.es:password')).toBe(true);
    const si = await run(v, ['borrar', 'wallapop'], ['wallapop.es']);
    expect(si.rc).toBe(0);
    expect(v.map.has('site:wallapop.es:password')).toBe(false);
  });

  it('una orden que no existe se explica en castellano llano', async () => {
    const r = await run(memVault(), ['listr']);
    expect(r.rc).toBe(2);
    expect(r.out).toMatch(/^No conozco esa orden\. Usa: pa cuentas listar/);
    expect(r.out).not.toMatch(/uso:/);
  });
});
