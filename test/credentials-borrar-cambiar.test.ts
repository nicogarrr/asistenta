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

async function seeded() {
  const v = memVault();
  await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com', notes: 'nota' }, v);
  return { v, pw: v.map.get('site:wallapop.es:password') ?? '' };
}

function run(v: VaultOps, argv: string[], answers: string[], hidden: string[] = [], tty = true) {
  const outs: string[] = [];
  const copied: Array<[string, number]> = [];
  const rc = cuentasCommand(argv, {
    vault: v,
    out: (s) => outs.push(s),
    ask: tty ? async () => answers.shift() ?? '' : undefined,
    askHidden: tty ? async () => hidden.shift() ?? '' : undefined,
    isTty: tty,
    copy: async (s, ms) => {
      copied.push([s, ms]);
    },
  });
  return { rc, outs, copied };
}

describe('pa cuentas borrar <web>', () => {
  it('solo borra tras escribir el nombre exacto de la web', async () => {
    const { v } = await seeded();
    const no = run(v, ['borrar', 'wallapop.es'], ['si']);
    expect(await no.rc).toBe(1);
    expect(v.map.has('site:wallapop.es:password')).toBe(true);
    const yes = run(v, ['borrar', 'www.wallapop.es'], ['wallapop.es']);
    expect(await yes.rc).toBe(0);
    expect([...v.map.keys()].filter((k) => k.includes('wallapop'))).toEqual([]);
    expect(yes.outs.join('\n')).toMatch(/Borrada wallapop\.es/);
  });

  it('sin terminal (una tubería o el shell del modelo) no borra', async () => {
    const { v } = await seeded();
    const r = run(v, ['borrar', 'wallapop.es'], [], [], false);
    expect(await r.rc).toBe(1);
    expect(r.outs.join('\n')).toMatch(/ventana de terminal/);
    expect(v.map.has('site:wallapop.es:password')).toBe(true);
  });

  it('una web que no está: lo dice y no toca nada', async () => {
    const { v } = await seeded();
    const r = run(v, ['borrar', 'amazon.es'], ['amazon.es']);
    expect(await r.rc).toBe(1);
    expect(v.map.size).toBe(3);
  });
});

describe('pa cuentas cambiar <web>', () => {
  it('guarda la nueva escrita dos veces tras CAMBIAR, sin imprimirla', async () => {
    const { v } = await seeded();
    const r = run(
      v,
      ['cambiar', 'wallapop.es'],
      ['CAMBIAR'],
      ['Nueva-Clave-123', 'Nueva-Clave-123'],
    );
    expect(await r.rc).toBe(0);
    expect(v.map.get('site:wallapop.es:password')).toBe('Nueva-Clave-123');
    expect(v.map.get('site:wallapop.es:username')).toBe('nico@gmail.com');
    expect(JSON.parse(v.map.get('cuenta:wallapop.es') ?? '{}').notes).toBe('nota');
    expect(r.outs.join('\n')).not.toContain('Nueva-Clave-123');
  });

  it('si no coinciden o no escribe CAMBIAR, no cambia nada', async () => {
    const { v, pw } = await seeded();
    expect(await run(v, ['cambiar', 'wallapop.es'], ['CAMBIAR'], ['a1', 'a2']).rc).toBe(1);
    expect(await run(v, ['cambiar', 'wallapop.es'], ['vale'], ['a1', 'a1']).rc).toBe(1);
    expect(v.map.get('site:wallapop.es:password')).toBe(pw);
  });

  it('vacío: genera una fuerte, la guarda y la copia al portapapeles sin imprimirla', async () => {
    const { v, pw } = await seeded();
    const r = run(v, ['cambiar', 'wallapop.es'], ['CAMBIAR'], ['']);
    expect(await r.rc).toBe(0);
    const nueva = v.map.get('site:wallapop.es:password') ?? '';
    expect(nueva).not.toBe(pw);
    expect(nueva.length).toBeGreaterThanOrEqual(20);
    expect(r.copied).toEqual([[nueva, 60_000]]);
    expect(r.outs.join('\n')).not.toContain(nueva);
  });

  it('sin terminal no cambia', async () => {
    const { v, pw } = await seeded();
    const r = run(v, ['cambiar', 'wallapop.es'], [], [], false);
    expect(await r.rc).toBe(1);
    expect(v.map.get('site:wallapop.es:password')).toBe(pw);
  });
});
