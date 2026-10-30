import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Un mensaje cada vez en el chat del panel, sin navegador: el código real de la página
// (enviarChat, repetirUltimo) con un DOM falso. Enter llama a requestSubmit(), que envía
// el formulario aunque «Enviar» esté desactivado.
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
    window: { setInterval: () => 0, clearInterval: () => {} },
    nodo: el,
    formato: { textoEspera: () => 'Pensando…' },
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
  return { ...fns, campo, boton, turnos, llamadas: () => llamadas };
}
function pendiente() {
  let soltar: (v: unknown) => void = () => {};
  const p = new Promise((r) => {
    soltar = r;
  });
  return { r: () => p, soltar };
}
const ok = () => Promise.resolve({ text: 'hecho' });
const falla500 = () => Promise.reject(Object.assign(new Error('HTTP 500'), { estado: 500 }));
const botonDe = (t: Fake | undefined) => t?.children.find((x) => x.tag === 'button');

describe('panel: un mensaje del chat cada vez', () => {
  it('Enter mientras Asistenta responde no manda un segundo mensaje y el texto se queda en el campo', async () => {
    const p = pendiente();
    const m = montar([p.r, ok], false);
    m.campo.value = 'hola';
    const primero = m.enviarChat(null);
    m.campo.value = 'y otra cosa';
    await m.enviarChat(null);
    expect(m.llamadas()).toBe(1);
    expect(m.campo.value).toBe('y otra cosa');
    expect(m.turnos.length).toBe(2);
    p.soltar({ text: 'hecho' });
    await primero;
    // con la respuesta ya en pantalla, se puede mandar
    await m.enviarChat(null);
    expect(m.llamadas()).toBe(2);
    expect(m.campo.value).toBe('');
  });

  it('mientras se repite un mensaje («Reintentar») tampoco se manda otro', async () => {
    const p = pendiente();
    const m = montar([p.r, ok], false);
    const repeticion = m.repetirUltimo();
    m.campo.value = 'nuevo';
    await m.enviarChat(null);
    expect(m.llamadas()).toBe(1);
    expect(m.campo.value).toBe('nuevo');
    p.soltar({ text: 'repetido' });
    await repeticion;
    await m.enviarChat(null);
    expect(m.llamadas()).toBe(2);
  });

  it('«Reintentar» de un fallo anterior no hace nada mientras otro mensaje espera respuesta', async () => {
    const p = pendiente();
    const m = montar([falla500, p.r, ok], false);
    m.campo.value = 'uno';
    await m.enviarChat(null);
    const reintentar = botonDe(m.turnos[1]);
    expect(reintentar).toBeDefined();
    m.campo.value = 'dos';
    const segundo = m.enviarChat(null);
    reintentar?.listeners.click?.();
    expect(m.llamadas()).toBe(2);
    expect(reintentar?.disabled).not.toBe(true);
    p.soltar({ text: 'hecho' });
    await segundo;
    reintentar?.listeners.click?.();
    expect(m.llamadas()).toBe(3);
    expect(reintentar?.disabled).toBe(true);
  });
});
