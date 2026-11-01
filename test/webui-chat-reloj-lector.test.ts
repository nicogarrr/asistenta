import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// «Pensando… N s» en el registro vivo del chat, sin navegador: el código real de la página
// (enviarChat, repetirUltimo) con un DOM falso. Lo que cambia cada segundo debe quedar
// oculto al lector de pantalla; si no, lo leería cada segundo.
interface Fake {
  tag: string;
  tagName: string;
  className: string | null;
  textContent: string;
  value: string;
  type?: string;
  disabled?: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  listeners: Record<string, () => void>;
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  addEventListener(n: string, f: () => void): void;
  querySelector(s: string): Fake | undefined;
  focus(): void;
}
const doc: { activeElement: Fake | null; body: Fake } = { activeElement: null, body: el('body') };
function el(tag: string, className: string | null = null, texto = ''): Fake {
  return {
    tag,
    tagName: tag.toUpperCase(),
    className,
    textContent: texto,
    value: '',
    attrs: {},
    children: [],
    listeners: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
    },
    addEventListener(n, fn) {
      this.listeners[n] = fn;
    },
    querySelector() {
      return this.children[0];
    },
    focus() {
      doc.activeElement = this;
    },
  };
}

type Respuesta = () => Promise<unknown>;
let tic: () => void = () => {};
function montar(respuestas: Respuesta[], movil: boolean) {
  const html = renderPage();
  const a = html.indexOf('async function enviarChat');
  const b = html.indexOf('// Archivos que devuelve', a);
  const c = html.indexOf('async function repetirUltimo');
  const d = html.indexOf('async function cargarObjetivos', c);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  expect(c).toBeGreaterThan(0);
  expect(d).toBeGreaterThan(c);
  const campo = el('textarea');
  const boton = el('button');
  doc.body = el('body');
  doc.activeElement = doc.body;
  const turnos: Fake[] = [];
  let llamadas = 0;
  const deps = {
    document: {
      ...doc,
      get activeElement() {
        return doc.activeElement;
      },
      get body() {
        return doc.body;
      },
      getElementById: (id: string) => (id === 'texto-chat' ? campo : boton),
    },
    window: {
      setInterval: (f: () => void) => {
        tic = f;
        return 1;
      },
      clearInterval: () => {},
    },
    nodo: el,
    formato: { textoEspera: (ms: number) => `Pensando… ${Math.floor(ms / 1000)} s` },
    anadirTurno: (clase: string, _quien: string, texto: string) => {
      const t = el('div', `turno ${clase}`);
      t.appendChild(el('p', 'texto', texto));
      turnos.push(t);
      return t;
    },
    enviar: () => {
      const r = respuestas[Math.min(llamadas, respuestas.length - 1)];
      llamadas++;
      return (r as Respuesta)();
    },
    pintarArchivos: () => {},
    avisoConexion: () => {},
    pantallaPequena: () => movil,
  };
  const fns = new Function(
    ...Object.keys(deps),
    `${html.slice(a, b)}\n${html.slice(c, d)}\nreturn { enviarChat, repetirUltimo };`,
  )(...Object.values(deps)) as {
    enviarChat: (e: unknown, t?: string) => Promise<void>;
    repetirUltimo: () => Promise<void>;
  };
  return { ...fns, campo, boton, turnos };
}
// Texto que oye el lector de pantalla: sin lo que cuelga de un nodo aria-hidden.
function oido(n: Fake): string {
  if (n.attrs['aria-hidden'] === 'true') return '';
  return n.textContent + n.children.map(oido).join('');
}
function visto(n: Fake): string {
  return n.textContent + n.children.map(visto).join('');
}

describe('panel: el reloj de «Pensando…» no se lee cada segundo', () => {
  it('mientras espera, los segundos cambian a la vista pero el lector sigue oyendo solo «Pensando…»', async () => {
    let soltar: (v: unknown) => void = () => {};
    const m = montar(
      [
        () =>
          new Promise((r) => {
            soltar = r;
          }),
      ],
      false,
    );
    m.campo.value = 'hola';
    const envio = m.enviarChat(null);
    const cuerpo = m.turnos[1]?.children[0] as Fake;
    const nowReal = Date.now;
    Date.now = () => nowReal() + 3000;
    try {
      tic();
    } finally {
      Date.now = nowReal;
    }
    expect(visto(cuerpo)).toMatch(/^Pensando… ?3 s$/);
    expect(oido(cuerpo).trim()).toBe('Pensando…');
    soltar({ text: 'hecho' });
    await envio;
    expect(oido(cuerpo)).toBe('hecho');
  });

  it('un «Reintentar» que espera no enseña «0 s» congelado', async () => {
    let soltar: (v: unknown) => void = () => {};
    const m = montar(
      [
        () =>
          new Promise((r) => {
            soltar = r;
          }),
      ],
      false,
    );
    const rep = m.repetirUltimo();
    expect(visto(m.turnos[0]?.children[0] as Fake)).toBe('Pensando…');
    soltar({ text: 'ok' });
    await rep;
  });
});
