import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createPriceWatchTool } from '../src/tools/price-watch.js';
import { PageWatchStore } from '../src/watch/pages.js';

// «vigila este enlace»: un fallo de la base de datos llegaba crudo al chat
// («No he podido crear la vigilancia: database is locked»).
function setup(addError?: Error) {
  const watches = new PageWatchStore(new DatabaseSync(':memory:'));
  if (addError)
    watches.add = () => {
      throw addError;
    };
  const tool = createPriceWatchTool({
    watches,
    scopeOf: () => 'chat-1',
    isFetchable: async () => true,
  });
  return async () => {
    const r = await tool.execute('t', {
      action: 'add',
      url: 'https://www.pccomponentes.com/x',
      target_eur: 399,
    } as never);
    const c = r.content[0];
    return c && c.type === 'text' ? c.text : '';
  };
}

const sqlite = (message: string, errstr: string) =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errstr });

describe('vigilar_precio: fallo al guardar en castellano llano', () => {
  it('base de datos bloqueada', async () => {
    const text = await setup(sqlite('database is locked', 'database is locked'))();
    expect(text).toContain('No he podido crear la vigilancia: no pude guardarla en el PC');
    expect(text).not.toMatch(/database|locked|SQLITE/i);
  });

  it('disco lleno dice qué hacer', async () => {
    const full = Object.assign(
      new Error("ENOSPC: no space left on device, write 'C:\\Users\\nico\\x.db'"),
      {
        code: 'ENOSPC',
      },
    );
    const text = await setup(full)();
    expect(text).toContain('el disco del PC está lleno');
    expect(text).not.toMatch(/ENOSPC|Users|\.db/);
  });

  it('los avisos propios del registro se dicen tal cual', async () => {
    const text = await setup(
      new Error('ya vigilas 20 páginas; quita alguna antes de añadir otra'),
    )();
    expect(text).toContain('ya vigilas 20 páginas');
  });
});
