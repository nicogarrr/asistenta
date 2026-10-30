import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

interface Fake {
  tag: string;
  className: string | null;
  textContent: string;
  open?: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  replaceChildren(...c: Fake[]): void;
}
function el(tag: string, className: string | null = null, texto = ''): Fake {
  return {
    tag,
    className,
    textContent: texto,
    attrs: {},
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
    },
    replaceChildren(...c) {
      this.children = c;
    },
  };
}
const areas = [
  {
    id: 'tele',
    titulo: 'Tele',
    resumen: 'Controla la tele',
    ejemplo: 'sube el volumen',
    comandos: [{ comando: '/tv', descripcion: 'mando' }],
  },
  { id: 'compras', titulo: 'Compras', resumen: 'Precios', ejemplo: 'vigila esto', comandos: [] },
];
/** cargarFunciones de la página con un DOM falso y un ancho de pantalla dado (sin navegador). */
async function cargar(movil: boolean): Promise<Fake> {
  const html = renderPage();
  const k = html.indexOf('async function cargarFunciones');
  const p = html.indexOf('function pantallaPequena');
  const i = p > 0 ? p : k;
  const j = html.indexOf('return false; }', k);
  expect(k).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  const contenedor = el('div');
  const documento = {
    getElementById: () => contenedor,
    createElement: (t: string) => el(t),
    createTextNode: (t: string) => el('#text', null, t),
  };
  const ventana = { matchMedia: (q: string) => ({ matches: movil && q === '(max-width: 780px)' }) };
  const fn = new Function(
    'document',
    'window',
    'nodo',
    'pedir',
    'pintarCarga',
    'finCarga',
    'pintarError',
    `${html.slice(i, j)}return false; }\n}\nreturn cargarFunciones;`,
  )(
    documento,
    ventana,
    el,
    async () => areas,
    () => {},
    () => {},
    (_c: unknown, e: unknown) => {
      throw e;
    },
  ) as () => Promise<boolean>;
  await fn();
  return contenedor;
}
const bloques = (c: Fake) => c.children.filter((h) => h.attrs['data-funcion']);

describe('panel: la tarjeta Funciones se pliega por áreas', () => {
  it('cada área es un <details> con su título en <summary>', async () => {
    const c = await cargar(false);
    const b = bloques(c);
    expect(b.map((x) => x.tag)).toEqual(['details', 'details']);
    expect(b[0]?.children[0]?.tag).toBe('summary');
    expect(b[0]?.children[0]?.children[0]).toMatchObject({ tag: 'h3', textContent: 'Tele' });
  });

  it('en pantalla grande empiezan abiertas; en el móvil (≤ 780 px), cerradas', async () => {
    expect(bloques(await cargar(false)).map((x) => x.open)).toEqual([true, true]);
    expect(bloques(await cargar(true)).map((x) => x.open)).toEqual([false, false]);
  });
});
