// La clave de OpenCode Go se busca en el MISMO orden en todas partes. #1875 puso la
// env OPENCODE_GO_API_KEY por delante del almacén en el proveedor (core/provider.ts),
// pero `pa doctor`, la prueba de modelos, la cuota de Go y el vigilante seguían
// mirando primero el almacén: el doctor daba por buena una clave que el chat no
// usaba. Y el campo «Clave de OpenCode Go» del panel guardaba en el almacén una clave
// que la env tapaba, diciendo «las conversaciones nuevas ya la usan».
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/vault.js', () => ({
  vaultGet: vi.fn(async (key: string) => (key === 'provider:apiKey' ? 'CLAVE-ALMACEN' : undefined)),
}));

import { aplicarClaveGo } from '../src/clave-panel.js';
import { fetchGoQuota } from '../src/core/go-quota.js';
import { providerKeyFor, providerKeySource } from '../src/llm-health.js';

const GO = 'https://opencode.ai/zen/go/v1';
const vault = (keys: Record<string, string>) => async (k: string) => keys[k];

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.OPENCODE_GO_API_KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.OPENCODE_GO_API_KEY;
  else process.env.OPENCODE_GO_API_KEY = saved;
});

describe('orden de la clave de OpenCode Go: la env manda, como en el proveedor', () => {
  it('pa doctor dice «env» cuando hay env y almacén (es la que usa el chat)', async () => {
    const r = await providerKeySource(GO, {
      getKey: vault({ 'provider:apiKey': 'vieja' }),
      env: { OPENCODE_GO_API_KEY: 'nueva' },
    });
    expect(r.source).toBe('env');
  });

  it('la búsqueda común da la env; sin env, el almacén; otros proveedores no cambian', async () => {
    const getKey = vault({ 'provider:apiKey': 'vieja', 'provider:openrouterKey': 'or-alm' });
    expect(await providerKeyFor('opencode', getKey, { OPENCODE_GO_API_KEY: ' nueva ' })).toBe(
      'nueva',
    );
    expect(await providerKeyFor('opencode', getKey, {})).toBe('vieja');
    expect(await providerKeyFor('openrouter', getKey, { OPENROUTER_API_KEY: 'or-env' })).toBe(
      'or-alm',
    );
    expect(await providerKeyFor('custom', getKey, { PA_API_KEY: 'p' })).toBe('p');
  });

  it('la cuota de Go pregunta con la clave que usa el chat', async () => {
    process.env.OPENCODE_GO_API_KEY = 'CLAVE-ENV';
    let auth = '';
    await fetchGoQuota(GO, {
      now: () => 9e15,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        auth = String((init?.headers as Record<string, string>).Authorization);
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    expect(auth).toBe('Bearer CLAVE-ENV');
  });
});

describe('panel: guardar la clave nueva no queda tapado por la env', () => {
  const okFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

  it('con OPENCODE_GO_API_KEY en el .env: la línea queda comentada y el proceso deja de usarla', async () => {
    const files: Record<string, string> = {
      'a/.env': 'PA_MODEL=deepseek-v4.1-flash\r\nOPENCODE_GO_API_KEY=vieja-123456\r\nOTRA=1\r\n',
    };
    const env: Record<string, string | undefined> = { OPENCODE_GO_API_KEY: 'vieja-123456' };
    const saved: string[] = [];
    const r = await aplicarClaveGo('nueva-abcdefghij', {
      fetchFn: okFetch,
      setKey: async (_k, v) => {
        saved.push(v);
      },
      env,
      files: ['a/.env', 'b/.env'],
      readFile: (p) => {
        const t = files[p];
        if (t === undefined) throw new Error('ENOENT');
        return Buffer.from(t);
      },
      writeFile: (p, t) => {
        files[p] = t;
      },
    });
    expect(r.ok).toBe(true);
    expect(saved).toEqual(['nueva-abcdefghij']);
    expect(env.OPENCODE_GO_API_KEY).toBeUndefined();
    expect(files['a/.env']).not.toMatch(/^OPENCODE_GO_API_KEY=/m);
    expect(files['a/.env']).not.toContain('vieja-123456');
    expect(files['a/.env']).toContain('PA_MODEL=deepseek-v4.1-flash\r\n');
    expect(files['a/.env']).toContain('OTRA=1');
  });

  it('con la env puesta fuera del .env (variables de Windows): avisa de que al reiniciar mandaría esa', async () => {
    const env: Record<string, string | undefined> = { OPENCODE_GO_API_KEY: 'vieja-123456' };
    const r = await aplicarClaveGo('nueva-abcdefghij', {
      fetchFn: okFetch,
      setKey: async () => undefined,
      env,
      files: ['a/.env'],
      readFile: () => Buffer.from('PA_MODEL=x\n'),
      writeFile: () => {
        throw new Error('no debería escribir');
      },
    });
    expect(r.ok).toBe(true);
    expect(env.OPENCODE_GO_API_KEY).toBeUndefined();
    expect(r.mensaje).toContain('OPENCODE_GO_API_KEY');
    expect(r.mensaje).not.toContain('vieja-123456');
  });

  it('sin env: igual que siempre, no toca ningún .env', async () => {
    const env: Record<string, string | undefined> = {};
    const r = await aplicarClaveGo('nueva-abcdefghij', {
      fetchFn: okFetch,
      setKey: async () => undefined,
      env,
      files: ['a/.env'],
      readFile: () => {
        throw new Error('no debería leer');
      },
      writeFile: () => {
        throw new Error('no debería escribir');
      },
    });
    expect(r).toEqual({
      ok: true,
      mensaje:
        'Clave guardada y comprobada con OpenCode Go. Las conversaciones nuevas ya la usan; si alguna abierta sigue fallando, escribe cualquier cosa de nuevo.',
    });
  });
});
