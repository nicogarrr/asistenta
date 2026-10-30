import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Tarjeta Objetivos sin navegador: el código real de cargarObjetivos con un DOM falso.
// Un objetivo sin plan no debe convertir toda la tarjeta en un error.
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

describe('Objetivos con plan ausente o raro', () => {
  it('pinta todos los objetivos aunque uno no tenga plan', async () => {
    const sinPlan = { ...base, id: 'g2', title: 'Sin plan', plan: undefined };
    const raro = { ...base, id: 'g3', title: 'Raro', plan: [null, { text: 'Bien', done: true }] };
    const { contenedor, errores, ok } = await pintar([sinPlan, raro, base]);
    expect(errores).toEqual([]);
    expect(ok).toBe(true);
    const textos = todos(contenedor).map((n) => n.textContent);
    expect(textos).toContain('Sin plan');
    expect(textos).toContain('Ahorrar');
    expect(textos).toContain('Sin plan todavía.');
    expect(textos).toContain('✓ Hecho: Bien');
    expect(activo).toBeNull();
  });
});
