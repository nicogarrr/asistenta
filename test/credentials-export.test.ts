import { describe, expect, it } from 'vitest';
import { cuentasCommand, toKeePassCsv } from '../src/credentials/export.js';
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
  await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
  await saveAccount({ site: 'a-medias.com', username: 'nico@gmail.com', status: 'pendiente' }, v);
  return { v, pw: v.map.get('site:wallapop.es:password') ?? '' };
}

describe('pa cuentas', () => {
  it('copiar: va al portapapeles con borrado a los 30 s y no se imprime', async () => {
    const { v, pw } = await seeded();
    const outs: string[] = [];
    const copied: Array<[string, number]> = [];
    const rc = await cuentasCommand(['copiar', 'wallapop.es'], {
      vault: v,
      out: (s) => outs.push(s),
      copy: async (s, ms) => {
        copied.push([s, ms]);
      },
    });
    expect(rc).toBe(0);
    expect(copied).toEqual([[pw, 30_000]]);
    expect(outs.join('\n')).not.toContain(pw);
    expect(outs.join('\n')).toContain('30 segundos');
  });

  it('exportar sin escribir EXPORTAR no escribe nada', async () => {
    const { v } = await seeded();
    const files: string[] = [];
    const rc = await cuentasCommand(['exportar', 'keepass', '/tmp/x.csv'], {
      vault: v,
      out: () => {},
      ask: async () => 'si',
      write: (p) => files.push(p),
    });
    expect(rc).toBe(1);
    expect(files).toEqual([]);
  });

  it('exportar keepass y bitwarden con confirmación: solo cuentas activas', async () => {
    const { v, pw } = await seeded();
    const files = new Map<string, string>();
    const outs: string[] = [];
    for (const fmt of ['keepass', 'bitwarden']) {
      const rc = await cuentasCommand(['exportar', fmt, `/tmp/x.${fmt}`], {
        vault: v,
        out: (s) => outs.push(s),
        ask: async () => 'EXPORTAR',
        write: (p, d) => files.set(p, d),
      });
      expect(rc).toBe(0);
    }
    const csv = files.get('/tmp/x.keepass') ?? '';
    expect(csv.split('\r\n')[0]).toBe('Group,Title,Username,Password,URL,Notes');
    expect(csv).toContain(pw);
    expect(csv).not.toContain('a-medias.com');
    const bw = JSON.parse(files.get('/tmp/x.bitwarden') ?? '{}');
    expect(bw.items).toHaveLength(1);
    expect(bw.items[0].login.password).toBe(pw);
    expect(outs.join('\n')).not.toContain(pw);
    expect(outs.join('\n')).toContain('texto plano');
  });

  it('CSV escapa comillas', () => {
    const csv = toKeePassCsv([
      { domain: 'x.com', username: 'a"b', password: 'p', created: '', notes: '', status: 'activa' },
    ]);
    expect(csv).toContain('"a""b"');
  });
});
