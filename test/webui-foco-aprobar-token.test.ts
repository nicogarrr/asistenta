import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Foco del teclado tras decidir una aprobación o guardar el token, sin navegador:
// el código real de la página (aprobar, devolverFoco, el envío del token) con un DOM falso.
interface Fake {
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  appendChild(c: Fake): void;
  replaceChildren(): void;
  querySelector(s: string): Fake | null;
  querySelectorAll(s: string): Fake[];
  focus(): void;
}
const doc: { activeElement: Fake | null; body: Fake } = { activeElement: null, body: el('body') };
function el(tag: string, className = '', texto = ''): Fake {
  return {
    tagName: tag.toUpperCase(),
    className,
    textContent: texto,
    value: '',
    disabled: false,
    hidden: false,
    attrs: {},
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    appendChild(c) {
      this.children.push(c);
    },
    replaceChildren() {
      this.children = [];
    },
    querySelector(s) {
      const clases = s.split('.').filter(Boolean);
      return (
        this.children.find((c) => clases.every((k) => c.className.split(' ').includes(k))) ?? null
      );
    },
    querySelectorAll(s) {
      return s === 'button' ? this.children.filter((c) => c.tagName === 'BUTTON') : [];
    },
    focus() {
      doc.activeElement = this;
    },
  };
}
const fakeDocument = (ids: Record<string, Fake>) => ({
  get activeElement() {
    return doc.activeElement;
  },
  get body() {
    return doc.body;
  },
  getElementById: (id: string) => ids[id],
});

const html = renderPage();
function trozo(desde: string, hasta: string): string {
  const a = html.indexOf(desde);
  const b = html.indexOf(hasta, a);
  expect(a).toBeGreaterThan(0);
  expect(b).toBeGreaterThan(a);
  return html.slice(a, b);
}

function montarAprobacion(enviar: () => Promise<unknown>, siguiente: boolean) {
  const contenedor = el('div');
  const tarjeta = el('article', 'aprobacion');
  tarjeta.setAttribute('data-titulo', 'Borrar archivo');
  const botones = ['Permitir una vez', 'Denegar'].map((t) => el('button', '', t));
  for (const b of botones) tarjeta.appendChild(b);
  tarjeta.appendChild(el('p', 'resultado'));
  contenedor.appendChild(tarjeta);
  doc.body = el('body');
  const fuente = `${trozo('var ultimaDecision', '// Cuenta atrás')}\n${trozo('function devolverFoco', 'async function cargarObjetivos')}\nreturn aprobar;`;
  const aprobar = new Function(
    'document',
    'window',
    'enviar',
    'mostrarAviso',
    'cargarAprobaciones',
    fuente,
  )(
    fakeDocument({ 'panel-aprobaciones': contenedor }),
    { confirm: () => true },
    enviar,
    () => {},
    async () => {
      // repintado: la tarjeta decidida desaparece (y el foco con ella) y sale el aviso
      contenedor.replaceChildren();
      contenedor.appendChild(el('p', 'resultado chip ok', 'Permitido una vez: «Borrar archivo».'));
      if (siguiente) {
        const otra = el('article', 'aprobacion');
        otra.appendChild(el('button', 'permitir', 'Permitir una vez'));
        contenedor.appendChild(otra);
      }
      doc.activeElement = doc.body;
    },
  ) as (id: string, d: { id: string; texto: string; hecho: string }, t: Fake) => Promise<void>;
  return { aprobar, contenedor, tarjeta, botones };
}
const unaVez = { id: 'once', texto: 'Permitir una vez', hecho: 'Permitido una vez' };
const denegar = { id: 'deny', texto: 'Denegar', hecho: 'Denegado' };

describe('panel: foco tras decidir una aprobación', () => {
  it('tras decidir, el foco va al aviso «Permitido…» y nunca al botón de otra aprobación', async () => {
    const m = montarAprobacion(() => Promise.resolve({}), true);
    m.botones[0]?.focus();
    await m.aprobar('a1', unaVez, m.tarjeta);
    const aviso = m.contenedor.children[0];
    expect(aviso?.className).toContain('chip');
    expect(doc.activeElement).toBe(aviso);
    expect(aviso?.attrs.tabindex).toBe('-1');
    expect(doc.activeElement?.tagName).not.toBe('BUTTON');
  });

  it('si la decisión falla, el foco vuelve al botón pulsado (ya activo) para reintentar', async () => {
    const m = montarAprobacion(() => Promise.reject(new Error('HTTP 500')), false);
    doc.activeElement = doc.body; // el botón pulsado se desactivó y perdió el foco
    await m.aprobar('a1', denegar, m.tarjeta);
    expect(m.botones[1]?.disabled).toBe(false);
    expect(doc.activeElement).toBe(m.botones[1]);
  });
});

describe('panel: foco tras guardar el token', () => {
  it('el formulario se oculta y el foco pasa al contenido principal', () => {
    const campo = el('input');
    campo.value = 'secreto';
    const formulario = el('form');
    const contenido = el('main');
    contenido.setAttribute('tabindex', '-1');
    const fuente = `var token = ''; var CLAVE_TOKEN = 'k';\nreturn ${trozo("function (evento) {\n        evento.preventDefault();\n        var campo = document.getElementById('campo-token')", '\n      });')}};`;
    const enviarToken = new Function('document', 'window', 'mostrarAviso', 'refrescarTodo', fuente)(
      fakeDocument({ 'campo-token': campo, contenido }),
      { localStorage: { setItem() {} } },
      () => {},
      () => {},
    ) as (e: unknown) => void;
    campo.focus();
    enviarToken({ preventDefault() {}, currentTarget: formulario });
    expect(formulario.hidden).toBe(true);
    expect(doc.activeElement).toBe(contenido);
  });
});
