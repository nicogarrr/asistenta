import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Tarjeta Objetivos sin navegador: el código real de cargarObjetivos con un DOM falso.
// Un objetivo sin título ni estado no debe dejar un encabezado vacío ni «undefined».
interface Fake {
  tagName: string;
  className: string;
  textContent: string;
  href?: string;
  attrs: Record<string, string>;
  children: Fake[];
  listeners: Record<string, (e: { preventDefault(): void }) => void>;
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  replaceChildren(...c: Fake[]): void;
  addEventListener(n: string, f: (e: { preventDefault(): void }) => void): void;
  focus(): void;
  scrollIntoView(): void;
}
let activo: Fake | null = null;
function el(tag: string, className = '', texto = ''): Fake {
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: texto,
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
    focus() {
      activo = this;
    },
    scrollIntoView() {},
  };
}
function todos(n: Fake): Fake[] {
  return n.children.flatMap((c) => [c, ...todos(c)]);
}

async function pintar(objetivos: unknown) {
  const html = renderPage();
  const a = html.indexOf('async function cargarObjetivos');
  const b = html.indexOf('async function cargarEstado', a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  const contenedor = el('div');
  const campo = el('textarea');
  const errores: unknown[] = [];
  const document = {
    getElementById: (id: string) =>
      id === 'panel-objetivos' ? contenedor : id === 'texto-chat' ? campo : null,
    createElement: (t: string) => el(t),
  };
  // nodo e insignia reales de la página (no pintan texto si es undefined/null).
  const n0 = html.indexOf('function nodo(');
  const n1 = html.indexOf('function nombreCampo', n0);
  const i0 = html.indexOf('function insignia(');
  const i1 = html.indexOf('function ', i0 + 'function insignia('.length);
  expect(n0).toBeGreaterThan(0);
  expect(i0).toBeGreaterThan(0);
  const reales = new Function(
    'document',
    `${html.slice(n0, n1)}\n${html.slice(i0, i1)}\nreturn [nodo, insignia];`,
  )(document);
  const nodo = reales[0];
  const insignia = reales[1];
  const formato = { progresoPlan: () => '', formatearCampo: () => '' };
  const fn = new Function(
    'document',
    'nodo',
    'insignia',
    'formato',
    'pedir',
    'pintarCarga',
    'finCarga',
    'pintarError',
    `${html.slice(a, b)}\nreturn cargarObjetivos;`,
  )(
    document,
    nodo,
    insignia,
    formato,
    async () => objetivos,
    () => {},
    () => {},
    (_c: Fake, e: unknown) => errores.push(e),
  );
  const ok = await fn();
  return { contenedor, campo, errores, ok };
}
const base = {
  id: 'g1',
  title: 'Ahorrar',
  status: 'active',
  thread: 'main',
  scope: 'owner',
  plan: [{ text: 'Paso', done: false }],
  updatedAt: '2026-10-30T20:00:00Z',
  panelChatAvailable: true,
};

describe('Objetivos sin título ni estado', () => {
  it('muestra «(sin título)» y «Sin estado», nunca «undefined»', async () => {
    const roto = {
      ...base,
      id: undefined,
      title: undefined,
      status: undefined,
      thread: undefined,
      scope: undefined,
    };
    const { contenedor, errores, ok } = await pintar([roto, base]);
    expect(errores).toEqual([]);
    expect(ok).toBe(true);
    const nodos = todos(contenedor);
    const h3 = nodos.filter((n) => n.tagName === 'H3').map((n) => n.textContent);
    expect(h3).toEqual(['(sin título)', 'Ahorrar']);
    const chips = nodos.filter((n) => n.className.startsWith('chip')).map((n) => n.textContent);
    expect(chips[0]).toBe('Sin estado');
    expect(nodos.some((n) => n.textContent.includes('undefined'))).toBe(false);
    expect(activo).toBeNull();
  });

  it('un título de solo espacios también usa «(sin título)»', async () => {
    const { contenedor } = await pintar([{ ...base, title: '   ' }]);
    const h3 = todos(contenedor).filter((n) => n.tagName === 'H3');
    expect(h3.map((n) => n.textContent)).toEqual(['(sin título)']);
  });
});
