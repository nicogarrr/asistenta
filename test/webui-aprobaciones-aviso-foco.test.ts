import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Tarjeta Aprobaciones sin navegador: el código real de pintarAprobaciones con un DOM
// falso. Tras decidir, el foco queda en el aviso «Permitido…»; la recarga silenciosa
// siguiente no debe borrarlo ni dejar el foco del teclado en el principio de la página.
interface Fake {
  tagName: string;
  className: string;
  textContent: string;
  disabled: boolean;
  parent: Fake | null;
  attrs: Record<string, string>;
  children: Fake[];
  classList: { contains(c: string): boolean };
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  replaceChildren(...c: Fake[]): void;
  contains(n: Fake | null): boolean;
  querySelector(s: string): Fake | null;
  closest(s: string): Fake | null;
  focus(): void;
}
let foco: Fake | null = null;
const body = el('body');
function todos(n: Fake): Fake[] {
  return n.children.flatMap((c) => [c, ...todos(c)]);
}
function el(tag: string, className = '', texto = ''): Fake {
  const yo: Fake = {
    tagName: tag.toUpperCase(),
    className,
    textContent: texto,
    disabled: false,
    parent: null,
    attrs: {},
    children: [],
    classList: { contains: (c) => yo.className.split(' ').includes(c) },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
    },
    replaceChildren(...c) {
      for (const x of this.children) x.parent = null;
      this.children = [];
      for (const x of c) this.appendChild(x);
    },
    contains(n) {
      for (let x = n; x; x = x.parent) if (x === this) return true;
      return false;
    },
    querySelector(s) {
      if (s === 'h2') return todos(this).find((x) => x.tagName === 'H2') ?? null;
      if (s === '.resultado.chip')
        return (
          todos(this).find(
            (x) => x.classList.contains('resultado') && x.classList.contains('chip'),
          ) ?? null
        );
      return null;
    },
    closest(s) {
      for (let x: Fake | null = this; x; x = x.parent)
        if (s === '.tarjeta' && x.classList.contains('tarjeta')) return x;
      return null;
    },
    focus() {
      foco = this;
    },
  };
  return yo;
}

function montar() {
  const html = renderPage();
  const trozo = (desde: string, hasta: string) => {
    const a = html.indexOf(desde);
    const b = html.indexOf(hasta, a + desde.length);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    return html.slice(a, b);
  };
  const tarjeta = el('article', 'tarjeta');
  const titulo = el('h2', '', 'Aprobaciones');
  const contenedor = el('div');
  tarjeta.appendChild(titulo);
  tarjeta.appendChild(contenedor);
  body.replaceChildren(tarjeta);
  const document = {
    get activeElement() {
      // Como un navegador: si el elemento con foco sale de la página, el foco va a body.
      return foco && body.contains(foco) ? foco : body;
    },
    body,
  };
  const nodo = (t: string, c: string | null, x?: string) => el(t, c ?? '', x ?? '');
  const fuente = `var ultimaDecision = '';\n${trozo('function listaDeAprobaciones', 'function ')}\n${trozo('function pintarAprobaciones', 'async function cargarAprobaciones')}\n${trozo('function devolverFoco', 'async function cargarObjetivos')}\nreturn { pintarAprobaciones, decidir: (t) => { ultimaDecision = t; } };`;
  const api = new Function(
    'document',
    'nodo',
    'marcarPendientes',
    'actualizarCaducidades',
    'renderValor',
    fuente,
  )(
    document,
    nodo,
    () => {},
    () => {},
    () => el('pre'),
  );
  return { api, contenedor, titulo };
}

describe('Aprobaciones: aviso «Permitido…» y foco en la recarga silenciosa', () => {
  it('con el foco en el aviso, la recarga lo conserva y el foco sigue en él', () => {
    const { api, contenedor } = montar();
    api.decidir('Permitido una vez: «Borrar archivo».');
    api.pintarAprobaciones(contenedor, []);
    const aviso = contenedor.querySelector('.resultado.chip');
    expect(aviso).not.toBeNull();
    aviso?.focus();
    api.pintarAprobaciones(contenedor, []);
    const nuevo = contenedor.querySelector('.resultado.chip');
    expect(nuevo?.textContent).toBe('Permitido una vez: «Borrar archivo».');
    expect(foco).toBe(nuevo);
  });

  it('si el foco estaba fuera de la tarjeta, la recarga no lo mueve ni resucita el aviso', () => {
    const { api, contenedor } = montar();
    api.decidir('Permitido una vez: «X».');
    api.pintarAprobaciones(contenedor, []);
    const fuera = el('textarea');
    body.appendChild(fuera);
    fuera.focus();
    api.pintarAprobaciones(contenedor, []);
    expect(contenedor.querySelector('.resultado.chip')).toBeNull();
    expect(foco).toBe(fuera);
  });
});
