import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Primer uso: un navegador sin almacenamiento (modo privado estricto o bloqueado)
// abría /?token=… y el panel pedía el token igual, porque solo lo leía de lo guardado.
function arranqueDelToken(html: string): string {
  const inicio = html.indexOf("var CLAVE_TOKEN = 'asistenta.webui.token';");
  const fin = html.indexOf("var aviso = document.getElementById('aviso');", inicio);
  expect(inicio).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(inicio);
  return `${html.slice(inicio, fin)}\nreturn token;`;
}

function abrir(search: string, localStorage: unknown) {
  const window = {
    location: { search, pathname: '/', hash: '' },
    localStorage,
    history: { replaceState: () => {} },
  };
  return new Function('window', arranqueDelToken(renderPage()))(window) as string;
}

const bloqueado = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

describe('panel: token de la URL sin almacenamiento', () => {
  it('usa el token del enlace en esta visita aunque no se pueda guardar', () => {
    expect(abrir('?token=abc123', bloqueado)).toBe('abc123');
  });

  it('sin localStorage en absoluto también usa el del enlace', () => {
    expect(abrir('?token=abc123', undefined)).toBe('abc123');
  });

  it('el enlace nuevo gana al token viejo guardado', () => {
    const almacen = new Map([['asistenta.webui.token', 'viejo']]);
    const ls = {
      getItem: (k: string) => almacen.get(k) ?? null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(abrir('?token=nuevo', ls)).toBe('nuevo');
  });

  it('sin token en el enlace sigue leyendo el guardado', () => {
    const ls = { getItem: () => 'guardado', setItem: () => {} };
    expect(abrir('', ls)).toBe('guardado');
  });
});
