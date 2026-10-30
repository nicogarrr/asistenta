import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Foco del teclado en el chat del panel, sin navegador: el código real de la página
// (enviarChat, repetirUltimo, devolverFoco) con un DOM falso.
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
  return { ...fns, campo, boton, turnos };
}
const ok = () => Promise.resolve({ text: 'hecho' });
const falla500 = () => Promise.reject(Object.assign(new Error('HTTP 500'), { estado: 500 }));
const botonDe = (t: Fake | undefined) => t?.children.find((x) => x.tag === 'button');

describe('panel: foco del teclado en el chat', () => {
  it('móvil: tras pulsar «Enviar» el foco no vuelve al campo (no se abre el teclado sobre la respuesta)', async () => {
    const m = montar([ok], true);
    m.campo.value = 'hola';
    await m.enviarChat(null);
    expect(doc.activeElement).not.toBe(m.campo);
    // el turno de la respuesta recibe el foco (lector de pantalla) sin abrir el teclado
    expect(doc.activeElement).toBe(m.turnos[1]);
    expect(m.turnos[1]?.attrs.tabindex).toBe('-1');
  });

  it('móvil con Enter (el campo tenía el foco): sigue en el campo para escribir otro', async () => {
    const m = montar([ok], true);
    m.campo.value = 'hola';
    m.campo.focus();
    await m.enviarChat(null);
    expect(doc.activeElement).toBe(m.campo);
  });

  it('escritorio: como siempre, el foco vuelve al campo', async () => {
    const m = montar([ok], false);
    m.campo.value = 'hola';
    await m.enviarChat(null);
    expect(doc.activeElement).toBe(m.campo);
  });

  it('«Reintentar» con teclado: si vuelve a fallar, el foco pasa al nuevo «Reintentar»', async () => {
    const m = montar([falla500], false);
    const viejo = el('button');
    viejo.focus();
    viejo.disabled = true; // el botón pulsado se desactiva y pierde el foco
    await m.repetirUltimo();
    const nuevo = botonDe(m.turnos[0]);
    expect(nuevo).toBeDefined();
    expect(doc.activeElement).toBe(nuevo);
  });

  it('«Reintentar» que sale bien lleva el foco al turno nuevo; si Nico ya escribe, no se toca', async () => {
    const m = montar([ok], false);
    doc.activeElement = doc.body;
    await m.repetirUltimo();
    expect(doc.activeElement).toBe(m.turnos[0]);
    const n = montar([ok], false);
    n.campo.focus();
    await n.repetirUltimo();
    expect(doc.activeElement).toBe(n.campo);
  });
});
