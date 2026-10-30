import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Tarjeta Objetivos sin navegador: el código real de cargarObjetivos con un DOM falso.
// «Ir al chat principal del panel» debe dejar el foco en el cuadro del chat.
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
  const nodo = (t: string, c: string | null, x?: string) => el(t, c ?? '', x ?? '');
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
    (c: string, t: string) => el('span', c, t),
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

describe('Objetivos → «Ir al chat principal del panel»', () => {
  it('pone el foco en el cuadro del chat y evita solo saltar al ancla', async () => {
    const { contenedor, campo } = await pintar([base]);
    const enlace = todos(contenedor).find((n) => n.tagName === 'A');
    expect(enlace?.href).toBe('#titulo-chat');
    let evitado = false;
    activo = null;
    enlace?.listeners.click?.({
      preventDefault() {
        evitado = true;
      },
    });
    expect(activo).toBe(campo);
    expect(evitado).toBe(true);
  });
});
