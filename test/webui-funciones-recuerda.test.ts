import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// La tarjeta Funciones recuerda qué áreas dejó abiertas o cerradas Nico
// (localStorage), sin navegador: se ejecuta el código real de la página con un DOM falso.
interface Fake {
  tag: string;
  className: string | null;
  textContent: string;
  open?: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  oyentes: Record<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  replaceChildren(...c: Fake[]): void;
  addEventListener(tipo: string, f: () => void): void;
}
function el(tag: string, className: string | null = null, texto = ''): Fake {
  return {
    tag,
    className,
    textContent: texto,
    attrs: {},
    children: [],
    oyentes: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
    },
    replaceChildren(...c) {
      this.children = c;
    },
    addEventListener(tipo, f) {
      const lista = this.oyentes[tipo] ?? [];
      lista.push(f);
      this.oyentes[tipo] = lista;
    },
  };
}
const areas = [
  { id: 'tele', titulo: 'Tele', resumen: 'r', ejemplo: 'e', comandos: [] },
  { id: 'compras', titulo: 'Compras', resumen: 'r', ejemplo: 'e', comandos: [] },
];
type Almacen = Map<string, string> | 'roto' | null;
async function cargar(movil: boolean, almacen: Almacen): Promise<Fake[]> {
  const html = renderPage();
  const i = html.indexOf('function pantallaPequena');
  const k = html.indexOf('async function cargarFunciones');
  const j = html.indexOf('return false; }', k);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(k);
  const contenedor = el('div');
  const documento = {
    getElementById: () => contenedor,
    createElement: (t: string) => el(t),
    createTextNode: (t: string) => el('#text', null, t),
  };
  const fallo = () => {
    throw new Error('SecurityError');
  };
  const localStorage =
    almacen === 'roto'
      ? { getItem: fallo, setItem: fallo }
      : almacen
        ? {
            getItem: (c: string) => almacen.get(c) ?? null,
            setItem: (c: string, v: string) => void almacen.set(c, String(v)),
          }
        : undefined;
  const ventana = {
    matchMedia: (q: string) => ({ matches: movil && q === '(max-width: 780px)' }),
    localStorage,
  };
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
  return contenedor.children.filter((h) => h.attrs['data-funcion']);
}
/** Pulsar el título (ratón, Enter o Espacio en un <summary> disparan «click»). */
function pulsar(b: Fake): void {
  const s = b.children[0] as Fake;
  for (const f of s.oyentes.click ?? []) f();
  b.open = !b.open; // la acción por defecto del navegador, después del oyente
}

describe('panel: Funciones recuerda las áreas abiertas o cerradas', () => {
  it('cerrar un área en el escritorio la deja cerrada al recargar', async () => {
    const almacen = new Map<string, string>();
    const b = await cargar(false, almacen);
    pulsar(b[0] as Fake);
    expect((await cargar(false, almacen)).map((x) => x.open)).toEqual([false, true]);
  });

  it('abrir un área en el móvil la deja abierta al recargar; las demás siguen cerradas', async () => {
    const almacen = new Map<string, string>();
    pulsar((await cargar(true, almacen))[1] as Fake);
    expect((await cargar(true, almacen)).map((x) => x.open)).toEqual([false, true]);
  });

  it('cargar sin tocar nada no guarda nada (el móvil no hereda el «abierto» del escritorio)', async () => {
    const almacen = new Map<string, string>();
    await cargar(false, almacen);
    expect(almacen.size).toBe(0);
    expect((await cargar(true, almacen)).map((x) => x.open)).toEqual([false, false]);
  });

  it('un valor guardado corrupto o un almacén bloqueado no rompen la tarjeta', async () => {
    const corrupto = new Map([['asistenta.webui.funciones', '{no es json']]);
    expect((await cargar(false, corrupto)).map((x) => x.open)).toEqual([true, true]);
    const b = await cargar(true, 'roto');
    expect(b.map((x) => x.open)).toEqual([false, false]);
    expect(() => pulsar(b[0] as Fake)).not.toThrow();
    expect((await cargar(false, null)).map((x) => x.open)).toEqual([true, true]);
  });

  it('solo guarda verdadero/falso por id de área, nada más', async () => {
    const almacen = new Map<string, string>();
    pulsar((await cargar(false, almacen))[0] as Fake);
    expect(JSON.parse(almacen.get('asistenta.webui.funciones') ?? '')).toEqual({ tele: false });
  });
});
