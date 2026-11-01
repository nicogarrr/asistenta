import { describe, expect, it } from 'vitest';
import { friendlyError } from '../src/channels/formatters.js';

function errWith(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe('friendlyError: lo que ve el usuario cuando algo falla', () => {
  it('un fallo de programación no enseña el mensaje interno', () => {
    const text = friendlyError(
      new TypeError("Cannot read properties of undefined (reading 'text')"),
      'Algo falló: ',
    );
    expect(text).not.toContain('Cannot read');
    expect(text).not.toContain('undefined');
    expect(text).toContain('Vuelve a intentarlo en un momento.');
    expect(text).not.toContain('/estado');
  });

  it('red, tiempo agotado, límite y clave: frase en español con qué hacer', () => {
    expect(friendlyError(new Error('fetch failed'))).toMatch(/fallo de red/);
    expect(friendlyError(errWith('connect', { code: 'ECONNREFUSED' }))).toMatch(/fallo de red/);
    expect(friendlyError(errWith('The operation was aborted', { name: 'AbortError' }))).toMatch(
      /tardado demasiado/,
    );
    expect(
      friendlyError(new Error('429 {"type":"error","error":{"type":"rate_limit_error"}}')),
    ).toMatch(/exceso de peticiones/);
    expect(friendlyError(new Error('401 invalid_api_key'))).toMatch(/clave/);
    expect(friendlyError(new Error('API error 529 overloaded'))).toMatch(/caído o saturado/);
  });

  it('nunca enseña la pila ni JSON ni secretos', () => {
    const err = new Error('boom {"a":1}');
    err.stack = 'Error: boom\n    at run (/app/dist/cli.js:10:5)';
    const text = friendlyError(err, 'Algo falló: ');
    expect(text).not.toContain(' at ');
    expect(text).not.toContain('{');
    const secret = friendlyError(new Error('token sk-abcdefghijklmnop rechazado'), 'Algo falló: ');
    expect(secret).not.toContain('sk-abcdefghijklmnop');
  });

  it('un mensaje propio corto de un comando se respeta tal cual', () => {
    expect(friendlyError(new Error('No encuentro ese id. Mira /vigilando.'))).toBe(
      'No encuentro ese id. Mira /vigilando.',
    );
    expect(friendlyError(new Error('objetivo= necesita un importe'), 'Algo falló: ')).toBe(
      'Algo falló: objetivo= necesita un importe',
    );
  });

  it('solo la primera línea, y nada vacío', () => {
    expect(friendlyError(new Error('Primera línea\nsegunda con detalles'))).toBe('Primera línea');
    expect(friendlyError(new Error(''))).toMatch(/Algo ha fallado/);
    expect(friendlyError(undefined)).toMatch(/Algo ha fallado/);
  });
});
