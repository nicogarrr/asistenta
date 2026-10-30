import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// «Reintentar» de una tarjeta que no cargó, sin navegador: el código real de la página
// (pintarError, devolverFoco) con un DOM falso. El bloque de error se repinta al
// recargar y el botón pulsado desaparece; el foco del teclado no debe perderse.
interface Fake {
  tagName: string;
  className: string;
  textContent: string;
  type?: string;
  disabled: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  listeners: Record<string, () => void>;
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  replaceChildren(...c: Fake[]): void;
  addEventListener(n: string, f: () => void): void;
  querySelector(s: string): Fake | null;
  closest(s: string): Fake | null;
  focus(): void;
}
const doc: { activeElement: Fake | null; body: Fake } = { activeElement: null, body: el('body') };
function todos(n: Fake): Fake[] {
  return n.children.flatMap((c) => [c, ...todos(c)]);
}
function el(tag: string, className = '', texto = ''): Fake {
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: texto,
    disabled: false,
    attrs: {},
    children: [],
    listeners: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
    },
    replaceChildren(...c) {
      this.children = c;
    },
    addEventListener(n, f) {
      this.listeners[n] = f;
    },
    querySelector(s) {
      const lista = todos(this);
      if (s === 'h2') return lista.find((x) => x.tagName === 'H2') ?? null;
      if (s === '.error-bloque button') {
        const bloque = lista.find((x) => x.className === 'error-bloque');
        return bloque?.children.find((x) => x.tagName === 'BUTTON') ?? null;
      }
      return null;
    },
    closest() {
      return tarjeta;
    },
    focus() {
      doc.activeElement = this;
    },
  };
}
let tarjeta: Fake | null = null;

function montar() {
  const html = renderPage();
  const trozo = (desde: string, hasta: string) => {
    const a = html.indexOf(desde);
    const b = html.indexOf(hasta, a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    return html.slice(a, b);
  };
  const fuente = `${trozo('function pintarError', 'function errorSinToken')}\n${trozo('function devolverFoco', 'async function cargarObjetivos')}\nreturn pintarError;`;
  const pintarError = new Function('document', 'nodo', 'finCarga', fuente)(
    {
      get activeElement() {
        return doc.activeElement;
      },
      get body() {
        return doc.body;
      },
    },
    el,
    () => {},
  ) as (c: Fake, e: unknown, r: () => Promise<unknown>) => void;
  const titulo = el('h2', '', 'Objetivos');
  const contenedor = el('div', 'tarjeta-cuerpo');
  tarjeta = el('article', 'tarjeta');
  tarjeta.appendChild(titulo);
  tarjeta.appendChild(contenedor);
  doc.body = el('body');
  return { pintarError, contenedor, titulo };
}
const boton = (c: Fake) => c.querySelector('.error-bloque button');
const pulsar = async (b: Fake | null) => {
  b?.focus();
  b?.listeners.click?.();
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('panel: foco tras «Reintentar» en una tarjeta con error', () => {
  it('si vuelve a fallar, el foco pasa al nuevo «Reintentar»', async () => {
    const m = montar();
    const recargar = async () => {
      m.pintarError(m.contenedor, new Error('HTTP 500'), recargar);
    };
    m.pintarError(m.contenedor, new Error('HTTP 500'), recargar);
    const viejo = boton(m.contenedor);
    await pulsar(viejo);
    const nuevo = boton(m.contenedor);
    expect(nuevo).not.toBe(viejo);
    expect(doc.activeElement).toBe(nuevo);
  });

  it('si carga bien, el foco pasa al título de la tarjeta (no se pierde)', async () => {
    const m = montar();
    const recargar = async () => {
      m.contenedor.replaceChildren(el('p', 'muted', 'Sin objetivos.'));
    };
    m.pintarError(m.contenedor, new Error('HTTP 500'), recargar);
    await pulsar(boton(m.contenedor));
    expect(doc.activeElement).toBe(m.titulo);
    expect(m.titulo.attrs.tabindex).toBe('-1');
  });

  it('si Nico ya movió el foco a otra parte mientras cargaba, no se toca', async () => {
    const m = montar();
    const otro = el('input');
    const recargar = async () => {
      otro.focus();
      m.contenedor.replaceChildren(el('p', 'muted', 'ok'));
    };
    m.pintarError(m.contenedor, new Error('HTTP 500'), recargar);
    await pulsar(boton(m.contenedor));
    expect(doc.activeElement).toBe(otro);
  });
});
