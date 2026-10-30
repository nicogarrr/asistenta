import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Extrae una función del script del panel por su nombre (cuerpo hasta la llave de cierre a 6 espacios).
function funcion(html: string, nombre: string): string {
  const inicio = html.indexOf(`function ${nombre}(`);
  expect(inicio).toBeGreaterThan(-1);
  const fin = html.indexOf('\n      }\n', inicio);
  return html.slice(inicio, fin + 8);
}

class Caja {
  attrs = new Map<string, string>();
  hijos: unknown[] = [];
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
  }
  replaceChildren(...n: unknown[]) {
    this.hijos = n;
  }
}

function cargar() {
  const html = renderPage();
  const fuente = `${funcion(html, 'pintarCarga')}\n${funcion(html, 'finCarga')}\nreturn { pintarCarga, finCarga };`;
  const nodo = (_tag: string, _clase: string, texto: string) => ({ texto });
  return new Function('nodo', fuente)(nodo) as {
    pintarCarga: (c: Caja) => void;
    finCarga: (c: Caja, ok: boolean) => void;
  };
}

describe('panel: recarga sin parpadeo', () => {
  it('la primera carga enseña «Cargando…» y marca aria-busy', () => {
    const { pintarCarga, finCarga } = cargar();
    const c = new Caja();
    pintarCarga(c);
    expect(c.hijos).toEqual([{ texto: 'Cargando…' }]);
    expect(c.getAttribute('aria-busy')).toBe('true');
    finCarga(c, true);
    expect(c.getAttribute('aria-busy')).toBeNull();
  });

  it('al recargar con datos ya pintados no los borra', () => {
    const { pintarCarga, finCarga } = cargar();
    const c = new Caja();
    pintarCarga(c);
    c.replaceChildren('datos');
    finCarga(c, true);
    pintarCarga(c);
    expect(c.hijos).toEqual(['datos']);
    expect(c.getAttribute('aria-busy')).toBe('true');
  });

  it('tras un error vuelve a avisar «Cargando…»', () => {
    const { pintarCarga, finCarga } = cargar();
    const c = new Caja();
    pintarCarga(c);
    finCarga(c, true);
    finCarga(c, false);
    pintarCarga(c);
    expect(c.hijos).toEqual([{ texto: 'Cargando…' }]);
  });

  it('cada carga con «Cargando…» termina con finCarga y el estilo atenúa lo ocupado', () => {
    const html = renderPage();
    const cargas = html.split('pintarCarga(contenedor);').length - 1;
    expect(cargas).toBeGreaterThan(0);
    expect(html.split('finCarga(contenedor, true);').length - 1).toBeGreaterThanOrEqual(cargas);
    expect(html).toContain("[aria-busy='true']");
  });
});
