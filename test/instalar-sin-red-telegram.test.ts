import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar, waitOwnerMessage } from '../scripts/instalar.mjs';

// Sin internet (o con Telegram caído) al esperar el «hola», fetch lanza una excepción.
// El instalador la confundía con un fallo de la caja fuerte («reinicia el PC») y paraba,
// aunque el token y la clave ya estaban guardados. Ahora dice que no llega a Telegram
// y deja escribir el ID a mano.
const TOKEN = `123456789:${'A'.repeat(35)}`;

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Asistenta',
    env: {},
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: (p: string) => p === '.env.example',
    copy: vi.fn(),
    readEnv: () => '',
    cli: vi.fn(async () => 1),
    vaultList: async () => [],
    vaultSet: vi.fn(async () => 0),
    ask: vi.fn(async (q: string) => {
      if (q.includes('token')) return TOKEN;
      if (q.includes('clave')) return 'clave-del-modelo';
      if (q.includes('ID')) return '123456789';
      return '';
    }),
    fetch: vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
    ...over,
  };
  return { d, text: () => out.join('') };
}

describe('instalar sin conexión con Telegram', () => {
  it('waitOwnerMessage devuelve «red» si fetch lanza', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await waitOwnerMessage(fetchFn, TOKEN)).toEqual({ error: 'red' });
  });

  it('waitOwnerMessage devuelve «red» si la respuesta no es JSON', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));
    expect(await waitOwnerMessage(fetchFn, TOKEN)).toEqual({ error: 'red' });
  });

  it('no culpa a la caja fuerte: avisa y deja escribir el ID a mano', async () => {
    const { d, text } = deps();
    expect(await instalar(d)).toBe(0);
    expect(text()).not.toContain('caja fuerte');
    expect(text()).toContain('No llego a Telegram');
    expect(d.vaultSet).toHaveBeenCalledWith('telegram:allowedUserIds', '123456789');
  });

  it('si no llega tu «hola» a tiempo, lo dice antes de pedir el ID', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: [] }),
    }));
    const { d, text } = deps({ fetch: fetchFn });
    expect(await instalar(d)).toBe(0);
    expect(text()).toContain('No me ha llegado tu mensaje');
    expect(d.vaultSet).toHaveBeenCalledWith('telegram:allowedUserIds', '123456789');
  });
});
