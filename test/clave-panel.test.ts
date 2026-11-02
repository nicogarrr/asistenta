// Campo «Clave de OpenCode Go» de la tarjeta Estado: validación en vivo antes
// de guardar en el almacén (bloqueo 2-nov-2026: clave vieja → 401 en todo).
import { describe, expect, it } from 'vitest';
import { aplicarClaveGo } from '../src/clave-panel.js';

function fetchCon(status: number): typeof fetch {
  return (() => Promise.resolve(new Response('{}', { status }))) as unknown as typeof fetch;
}

const fetchFallo = (() => Promise.reject(new Error('sin red'))) as unknown as typeof fetch;

describe('aplicarClaveGo', () => {
  it('rechaza claves con mala pinta sin llamar a la red', async () => {
    let llamada = false;
    const r = await aplicarClaveGo('corta', {
      setKey: async () => {},
      fetchFn: (() => {
        llamada = true;
        return Promise.resolve(new Response('{}'));
      }) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(llamada).toBe(false);
    expect(r.mensaje).toContain('OpenCode');
  });

  it('guarda una clave que Go acepta, sin devolverla', async () => {
    let guardada: string | null = null;
    const r = await aplicarClaveGo('  clave-buena-1234567890  ', {
      setKey: async (key, value) => {
        expect(key).toBe('provider:apiKey');
        guardada = value;
      },
      fetchFn: fetchCon(200),
    });
    expect(r.ok).toBe(true);
    expect(guardada).toBe('clave-buena-1234567890');
    expect(r.mensaje).not.toContain('clave-buena-1234567890');
    expect(r.mensaje).toContain('guardada');
  });

  it('no guarda una clave que Go rechaza (401)', async () => {
    let escritas = 0;
    const r = await aplicarClaveGo('clave-mala-1234567890', {
      setKey: async () => {
        escritas++;
      },
      fetchFn: fetchCon(401),
    });
    expect(r.ok).toBe(false);
    expect(escritas).toBe(0);
    expect(r.mensaje).toContain('no vale');
  });

  it('sin conexión no guarda y lo dice claro', async () => {
    let escritas = 0;
    const r = await aplicarClaveGo('clave-buena-1234567890', {
      setKey: async () => {
        escritas++;
      },
      fetchFn: fetchFallo,
    });
    expect(r.ok).toBe(false);
    expect(escritas).toBe(0);
    expect(r.mensaje).toContain('No la he guardado');
  });

  it('un 5xx de Go tampoco guarda', async () => {
    const r = await aplicarClaveGo('clave-buena-1234567890', {
      setKey: async () => {},
      fetchFn: fetchCon(503),
    });
    expect(r.ok).toBe(false);
    expect(r.mensaje).toContain('No la he guardado');
  });
});
