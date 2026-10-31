import { describe, expect, it } from 'vitest';
import { findAccounts, type VaultOps } from '../src/credentials/store.js';
import { createAccountsTool } from '../src/tools/accounts.js';

function memVault(entries: Record<string, string>): VaultOps {
  const m = new Map(Object.entries(entries));
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => {
      m.set(k, v);
    },
    delete: async (k) => m.delete(k),
    list: async () => [...m.keys()],
  };
}

const V = memVault({
  'site:wallapop.es:username': 'nicogarrr',
  'site:wallapop.es:password': 'SECRETO-1',
  'site:es.wallapop.com:username': 'otro@example.com',
  'site:es.wallapop.com:password': 'SECRETO-2',
  'site:fax.es:username': 'fax-user',
  'site:fax.es:password': 'SECRETO-3',
  'site:login.x.es:username': 'equis',
  'site:login.x.es:password': 'SECRETO-4',
});
const domains = async (q: string) => (await findAccounts(q, V)).map((a) => a.domain).sort();

describe('buscar con un dominio: solo esa web (y sus subdominios)', () => {
  it('wallapop.es no trae es.wallapop.com, ni al revés', async () => {
    expect(await domains('wallapop.es')).toEqual(['wallapop.es']);
    expect(await domains('https://www.wallapop.es/login')).toEqual(['wallapop.es']);
    expect(await domains('es.wallapop.com')).toEqual(['es.wallapop.com']);
  });

  it('«x.es» no es «fax.es», pero sí su subdominio login.x.es', async () => {
    expect(await domains('x.es')).toEqual(['login.x.es']);
  });

  it('por nombre a secas siguen saliendo las dos', async () => {
    expect(await domains('wallapop')).toEqual(['es.wallapop.com', 'wallapop.es']);
  });

  it('«¿cuál es mi usuario en wallapop.es?» da el usuario entero de esa web', async () => {
    const r = await createAccountsTool(V, async () => null).execute('c', {
      action: 'buscar',
      sitio: 'wallapop.es',
    } as never);
    const t = JSON.stringify(r);
    expect(t).toContain('nicogarrr');
    expect(t).not.toContain('otro@example.com');
    expect(t).not.toContain('SECRETO');
  });
});
