import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Tarjeta Rutinas sin navegador: el código real de cargarRutinas con un DOM falso.
// Al volver a la pestaña se repinta en silencio; si el foco estaba en la tarjeta
// (por ejemplo en «Reintentar») no debe irse al principio de la página.
interface Fake {
  tagName: string;
  className: string;
  textContent: string;
  disabled?: boolean;
  parent: Fake | null;
  attrs: Record<string, string>;
  children: Fake[];
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  appendChild(c: Fake): void;
  replaceChildren(...c: Fake[]): void;
  contains(n: unknown): boolean;
  closest(sel: string): Fake | null;
  querySelector(sel: string): Fake | null;
  focus(): void;
}
let activo: Fake | null = null;
function todos(n: Fake): Fake[] {
  return n.children.flatMap((c) => [c, ...todos(c)]);
}
function el(tag: string, className = '', texto = ''): Fake {
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: texto,
    parent: null,
    attrs: {},
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return k in this.attrs ? (this.attrs[k] ?? null) : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
    },
    replaceChildren(...c) {
      for (const v of this.children) v.parent = null;
      this.children = [];
      for (const n of c) this.appendChild(n);
    },
    contains(n) {
      return n === this || todos(this).includes(n as Fake);
    },
    closest(sel) {
      let n: Fake | null = this;
      while (n) {
        if (sel === '.tarjeta' && n.className.split(' ').includes('tarjeta')) return n;
        n = n.parent;
      }
      return null;
    },
    querySelector(sel) {
      return todos(this).find((n) => n.tagName === sel.toUpperCase()) ?? null;
    },
    focus() {
      activo = this;
    },
  };
}

function montar(respuesta: unknown) {
  const html = renderPage();
  const a = html.indexOf('async function cargarRutinas');
  const b = html.indexOf('function pantallaPequena', a);
  const d = html.indexOf('function devolverFoco');
  const e = html.indexOf('var chatOcupado', d);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  expect(d).toBeGreaterThan(0);
  expect(e).toBeGreaterThan(d);
  const raiz = el('body');
  const tarjeta = el('article', 'tarjeta');
  const h2 = el('h2', '', 'Rutinas');
  const contenedor = el('div');
  const fuera = el('input');
  raiz.appendChild(tarjeta);
  raiz.appendChild(fuera);
  tarjeta.appendChild(h2);
  tarjeta.appendChild(contenedor);
  const document = {
    body: raiz,
    get activeElement() {
      return activo && raiz.contains(activo) ? activo : raiz;
    },
    getElementById: (id: string) => (id === 'panel-rutinas' ? contenedor : null),
  };
  const nodo = (t: string, c: string | null, x?: string) => el(t, c ?? '', x ?? '');
  const cargar = new Function(
    'document',
    'nodo',
    'insignia',
    'pedir',
    'pintarCarga',
    'finCarga',
    'pintarError',
    `${html.slice(d, e)}\n${html.slice(a, b)}\nreturn cargarRutinas;`,
  )(
    document,
    nodo,
    (c: string, t: string) => el('span', c, t),
    async () => respuesta,
    () => {},
    () => {},
    () => {},
  );
  return { cargar, contenedor, h2, fuera };
}
const rutina = {
  nombre: 'resumen',
  activa: true,
  proxima: 'mañana 8:00',
  horario: '0 8 * * *',
  ultima: null,
};

describe('Rutinas: repintado en silencio y foco', () => {
  it('si el foco estaba en «Reintentar» de la tarjeta, pasa al título y no se pierde', async () => {
    const { cargar, contenedor, h2 } = montar([rutina]);
    const reintentar = el('button', 'mini', 'Reintentar');
    contenedor.appendChild(reintentar);
    reintentar.focus();
    expect(await cargar(true)).toBe(true);
    expect(activo).toBe(h2);
    expect(h2.attrs.tabindex).toBe('-1');
  });

  it('si el foco está fuera de la tarjeta, no se toca', async () => {
    const { cargar, fuera } = montar([rutina]);
    fuera.focus();
    expect(await cargar(true)).toBe(true);
    expect(activo).toBe(fuera);
  });
});
