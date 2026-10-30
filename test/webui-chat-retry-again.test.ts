import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

interface Fake {
  tag: string;
  className: string | null;
  textContent: string;
  type?: string;
  disabled?: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  listeners: Record<string, () => void>;
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  addEventListener(n: string, f: () => void): void;
  querySelector(s: string): Fake | undefined;
}
function el(tag: string, className: string | null = null, texto = ''): Fake {
  const f: Fake = {
    tag,
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
    addEventListener(n, fn) {
      this.listeners[n] = fn;
    },
    querySelector() {
      return this.children[0];
    },
  };
  return f;
}

type Respuesta = () => Promise<unknown>;
/** repetirUltimo de la página con dependencias falsas (sin navegador). */
function montar(respuestas: Respuesta[]) {
  const html = renderPage();
  const i = html.indexOf('async function repetirUltimo');
  const j = html.indexOf('async function cargarObjetivos', i);
  expect(i).toBeGreaterThan(0);
  const turnos: Fake[] = [];
  const avisos: unknown[][] = [];
  let llamadas = 0;
  const deps = {
    nodo: el,
    formato: { textoEspera: () => 'Pensando…' },
    anadirTurno: (clase: string, quien: string, texto: string) => {
      const t = el('div', `turno ${clase}`);
      t.appendChild(el('p', 'texto', texto));
      t.attrs.quien = quien;
      turnos.push(t);
      return t;
    },
    enviar: () => {
      const r = respuestas[Math.min(llamadas, respuestas.length - 1)];
      llamadas++;
      return (r as Respuesta)();
    },
    pintarArchivos: () => {},
    avisoConexion: (...a: unknown[]) => avisos.push(a),
  };
  const fn = new Function(...Object.keys(deps), `${html.slice(i, j)}; return repetirUltimo;`)(
    ...Object.values(deps),
  ) as () => Promise<void>;
  return { fn, turnos, avisos, llamadas: () => llamadas };
}
const falla =
  (estado: number, extra: Record<string, unknown> = {}) =>
  () =>
    Promise.reject(Object.assign(new Error(`HTTP ${estado}`), { estado, ...extra }));
const botones = (t: Fake | undefined) => (t?.children ?? []).filter((c) => c.tag === 'button');

describe('panel: «Reintentar» en un turno repetido que también falla', () => {
  it('si la repetición falla (500), sale otro «Reintentar» que vuelve a repetir', async () => {
    const m = montar([falla(500), () => Promise.resolve({ text: 'ya va' })]);
    await m.fn();
    expect(m.turnos[0]?.className).toContain('fallo');
    const [boton] = botones(m.turnos[0]);
    expect(boton?.textContent).toBe('Reintentar');
    boton?.listeners.click?.();
    expect(boton?.disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.llamadas()).toBe(2);
    expect(m.turnos[1]?.children[0]?.textContent).toBe('ya va');
  });

  it('sin conexión también se puede volver a intentar', async () => {
    const m = montar([() => Promise.reject(Object.assign(new Error('x'), { sinConexion: true }))]);
    await m.fn();
    expect(botones(m.turnos[0])).toHaveLength(1);
  });

  it('sin botón si no hay nada que repetir (409) o falta el token', async () => {
    const a = montar([falla(409)]);
    await a.fn();
    expect(botones(a.turnos[0])).toHaveLength(0);
    const b = montar([falla(401, { sinToken: true })]);
    await b.fn();
    expect(botones(b.turnos[0])).toHaveLength(0);
  });

  it('si la repetición sale bien, quita el aviso de «sin conexión»', async () => {
    const m = montar([() => Promise.resolve({ text: 'ok' })]);
    await m.fn();
    expect(m.avisos).toContainEqual([false]);
  });

  it('los errores HTTP del panel llevan su código (estado) para decidirlo', () => {
    const html = renderPage();
    expect(html).toContain('fallo.estado = respuesta.status');
  });
});
