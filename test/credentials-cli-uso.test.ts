import { describe, expect, it } from 'vitest';
import { cuentasCommand } from '../src/credentials/export.js';
import { saveAccount, type VaultOps } from '../src/credentials/store.js';

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

async function run(argv: string[], vault: VaultOps = memVault()) {
  const lines: string[] = [];
  const copied: string[] = [];
  const code = await cuentasCommand(argv, {
    vault,
    out: (s) => lines.push(s),
    copy: async (s) => {
      copied.push(s);
    },
  });
  return { code, text: lines.join('\n'), copied };
}

describe('pa cuentas: órdenes a medias y fallos, en llano', () => {
  it('«pa cuentas copiar» sin web dice qué falta, no «no conozco esa orden»', async () => {
    for (const sub of ['copiar', 'borrar', 'cambiar']) {
      const { code, text } = await run([sub]);
      expect(code).toBe(2);
      expect(text).toContain(`Falta la web: pa cuentas ${sub} <web>`);
      expect(text).not.toMatch(/No conozco/);
    }
  });

  it('«pa cuentas exportar» sin formato o sin fichero dice qué falta', async () => {
    expect((await run(['exportar'])).text).toMatch(/^¿A qué formato\?/);
    expect((await run(['exportar', 'csv', 'x.csv'])).text).toMatch(/^¿A qué formato\?/);
    expect((await run(['exportar', 'keepass'])).text).toContain('Falta el fichero');
  });

  it('entiende «lista», «copia» y mayúsculas', async () => {
    const v = memVault();
    await saveAccount(
      { site: 'wallapop.es', username: 'nico@example.com', password: 'S3creta!x' },
      v,
    );
    expect((await run(['lista'], v)).text).toContain('wallapop.es');
    expect((await run(['LISTAR'], v)).text).toContain('wallapop.es');
    const c = await run(['copia', 'wallapop.es'], v);
    expect(c.code).toBe(0);
    expect(c.copied).toEqual(['S3creta!x']);
    expect(c.text).not.toContain('S3creta');
  });

  it('si el gestor no se puede leer, una línea llana sin el error crudo', async () => {
    const broken: VaultOps = {
      get: async () => {
        throw new Error('DPAPI decrypt failed: C:\\Users\\nico\\.pa\\vault.json');
      },
      set: async () => {},
      delete: async () => false,
      list: async () => {
        throw new Error('DPAPI decrypt failed: C:\\Users\\nico\\.pa\\vault.json');
      },
    };
    const { code, text } = await run(['listar'], broken);
    expect(code).toBe(1);
    expect(text).toMatch(/no puedo leer tu gestor de contraseñas/);
    expect(text).not.toMatch(/DPAPI|vault\.json|Users/);
  });
});
