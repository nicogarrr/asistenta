import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

interface FakeNode {
  tag: string;
  className: string;
  textContent: string;
  title: string;
  children: FakeNode[];
  listeners: Record<string, () => void>;
  appendChild(n: FakeNode): FakeNode;
  addEventListener(ev: string, fn: () => void): void;
}

function fakeNode(tag: string, text = ''): FakeNode {
  const n: FakeNode = {
    tag,
    className: '',
    textContent: text,
    title: '',
    children: [],
    listeners: {},
    appendChild(c) {
      n.children.push(c);
      return c;
    },
    addEventListener(ev, fn) {
      n.listeners[ev] = fn;
    },
  };
  return n;
}

const visible = (n: FakeNode): string => n.textContent + n.children.map(visible).join('');

/** Saca una función del script del panel y la ejecuta con un DOM de mentira. */
function panelFn(name: string, clipboard: string[] = []): (x: unknown) => FakeNode {
  const html = renderPage();
  const pick = (fn: string): string => {
    const m = html.match(new RegExp(`\\n {6}function ${fn}\\([\\s\\S]*?\\n {6}\\}\\n`));
    if (!m) throw new Error(`no encuentro ${fn}`);
    return m[0];
  };
  const document = {
    createElement: (tag: string) => fakeNode(tag),
    createTextNode: (text: string) => fakeNode('#text', text),
  };
  const navigator = {
    clipboard: {
      writeText: (t: string) => {
        clipboard.push(t);
        return Promise.resolve();
      },
    },
  };
  const src = `${pick('nodo')}${pick('insignia')}${pick(name)}return ${name};`;
  return new Function('document', 'navigator', src)(document, navigator);
}

describe('panel: filas de tareas y paquetes', () => {
  it('una tarea que se repite lo dice en el panel, como en el chat', () => {
    const fila = panelFn('filaTarea');
    const li = fila({
      dia: 'lunes 2',
      titulo: 'sacar la basura',
      estado: 'pendiente',
      repite: 'cada semana',
    });
    expect(visible(li)).toContain('sacar la basura (cada semana)');
    expect(visible(fila({ dia: 'lunes 2', titulo: 'banco', estado: 'pendiente' }))).not.toContain(
      '(',
    );
  });

  it('el número de seguimiento va aparte, entero y copiable con un toque', () => {
    const copiado: string[] = [];
    const fila = panelFn('filaReparto', copiado);
    const li = fila({
      envio: 'SEUR',
      seguimiento: 'ES123456789',
      titulo: 'Tu pedido está en camino',
      cuando: '29 oct, 9:30',
      estado: 'en reparto',
    });
    const code = li.children.find((c) => c.tag === 'code');
    expect(code?.textContent).toBe('ES123456789');
    expect(code?.className).toBe('copiable');
    code?.listeners.click?.();
    expect(copiado).toEqual(['ES123456789']);
    expect(visible(li)).toBe(
      'SEUR ES123456789 · Tu pedido está en camino (29 oct, 9:30) en reparto',
    );
    const sin = fila({ envio: 'GLS', titulo: 'Enviado', cuando: 'hoy', estado: 'enviado' });
    expect(sin.children.some((c) => c.tag === 'code')).toBe(false);
    expect(renderPage()).toMatch(/\.copiable \{ user-select: all;/);
  });
});
