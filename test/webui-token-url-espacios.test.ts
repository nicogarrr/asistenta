import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Primer uso en Windows: el enlace del panel se copia a menudo con un espacio o un
// salto de línea al final (?token=abc%0A). Ese token no coincidía nunca y el panel
// pedía el token una y otra vez aunque fuera el bueno.
function arranqueDelToken(html: string): string {
  const inicio = html.indexOf("var CLAVE_TOKEN = 'asistenta.webui.token';");
  const fin = html.indexOf("var aviso = document.getElementById('aviso');", inicio);
  expect(inicio).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(inicio);
  return `${html.slice(inicio, fin)}\nreturn token;`;
}

function abrir(search: string, guardado: string | null = null) {
  const almacen = new Map<string, string>();
  if (guardado !== null) almacen.set('asistenta.webui.token', guardado);
  const urls: string[] = [];
  const window = {
    location: { search, pathname: '/', hash: '' },
    localStorage: {
      getItem: (k: string) => almacen.get(k) ?? null,
      setItem: (k: string, v: string) => almacen.set(k, v),
    },
    history: { replaceState: (_a: unknown, _b: string, url: string) => urls.push(url) },
  };
  const token = new Function('window', arranqueDelToken(renderPage()))(window) as string;
  return { token, guardado: almacen.get('asistenta.webui.token'), urls };
}

describe('panel: token de la URL con espacios', () => {
  it('recorta el salto de línea y los espacios del ?token= antes de guardarlo', () => {
    const r = abrir('?token=%20abc123%0D%0A');
    expect(r.token).toBe('abc123');
    expect(r.guardado).toBe('abc123');
    expect(r.urls).toEqual(['/']);
  });

  it('un token guardado antes con espacios también se recorta', () => {
    expect(abrir('', 'abc123\n').token).toBe('abc123');
  });

  it('un ?token= solo con espacios no borra el token bueno guardado', () => {
    const r = abrir('?token=%20%0A', 'bueno');
    expect(r.token).toBe('bueno');
    expect(r.guardado).toBe('bueno');
  });
});
