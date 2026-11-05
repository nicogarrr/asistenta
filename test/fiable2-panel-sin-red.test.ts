import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runPanelChat } from '../src/daemon/panel-chat.js';
import { renderPage } from '../src/webui/page.js';

// Sin internet (o con el modelo caído), un mensaje escrito en el chat del panel
// devolvía «prueba en un momento» y se quedaba ahí: Telegram ya lo reintentaba solo
// (#2002), el panel no.

interface Fake {
  tag: string;
  className: string | null;
  textContent: string;
  removed?: boolean;
  attrs: Record<string, string>;
  children: Fake[];
  listeners: Record<string, () => void>;
  setAttribute(k: string, v: string): void;
  appendChild(c: Fake): void;
  addEventListener(n: string, f: () => void): void;
  querySelector(s: string): Fake | undefined;
  remove(): void;
}
function el(tag: string, className: string | null = null, texto = ''): Fake {
  return {
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
    remove() {
      this.removed = true;
    },
  };
}

type Respuesta = () => Promise<unknown>;
function montar(respuestas: Respuesta[]) {
  const html = renderPage();
  const i = html.indexOf('// intentoAuto:');
  const j = html.indexOf('async function cargarObjetivos', i);
  expect(i).toBeGreaterThan(0);
  const turnos: Fake[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let llamadas = 0;
  const deps = {
    nodo: el,
    formato: { textoEspera: () => 'Pensando…' },
    anadirTurno: (clase: string, _quien: string, texto: string) => {
      const t = el('div', `turno ${clase}`);
      t.appendChild(el('p', 'texto', texto));
      turnos.push(t);
      return t;
    },
    enviar: (ruta: string) => {
      expect(ruta).toBe('/api/chat/retry');
      const r = respuestas[Math.min(llamadas, respuestas.length - 1)];
      llamadas++;
      return (r as Respuesta)();
    },
    pintarArchivos: () => {},
    avisoConexion: () => {},
    document: { activeElement: null, body: {} },
    window: {
      setTimeout: (fn: () => void, ms: number) => {
        timers.push({ fn, ms, cleared: false });
        return timers.length - 1;
      },
      clearTimeout: (id: number) => {
        const t = timers[id];
        if (t) t.cleared = true;
      },
    },
  };
  const api = new Function(
    ...Object.keys(deps),
    `${html.slice(i, j)}; return { repetirUltimo, programarReintento, cancelarReintento };`,
  )(...Object.values(deps)) as {
    repetirUltimo: (n?: number) => Promise<void>;
    programarReintento: (turno: Fake, n: number) => void;
    cancelarReintento: () => void;
  };
  const vivos = () => timers.filter((t) => !t.cleared);
  const disparar = async () => {
    const t = vivos().at(-1);
    if (!t) throw new Error('sin temporizador');
    t.cleared = true;
    t.fn();
    for (let k = 0; k < 10; k++) await Promise.resolve();
  };
  return { api, turnos, timers, vivos, disparar, llamadas: () => llamadas };
}
const sinRed = () =>
  Promise.resolve({ text: 'No llego al modelo: sin conexión.', outage: true as const });
const nota = (t: Fake | undefined) =>
  t?.children.find((c) => (c.className ?? '').includes('reintento-solo'));

describe('chat del panel sin red: se reintenta solo', () => {
  it('avisa «lo reintento yo solo en 1 min» y lo repite al minuto', async () => {
    const m = montar([sinRed, () => Promise.resolve({ text: 'Ya va: son las 9.' })]);
    await m.api.repetirUltimo();
    expect(nota(m.turnos[0])?.textContent).toContain('Lo reintento yo solo en 1 min');
    expect(m.vivos().map((t) => t.ms)).toEqual([60_000]);
    await m.disparar();
    expect(m.llamadas()).toBe(2);
    expect(m.turnos[1]?.children[0]?.textContent).toBe('Ya va: son las 9.');
    expect(m.vivos()).toEqual([]);
  });

  it('si sigue sin red espera más (1, 2, 5, 10, 15 min) sin llenar el chat, y luego lo deja', async () => {
    const m = montar([sinRed]);
    await m.api.repetirUltimo();
    const esperas = [m.vivos()[0]?.ms];
    for (let n = 0; n < 5; n++) {
      await m.disparar();
      esperas.push(m.vivos()[0]?.ms);
    }
    expect(esperas).toEqual([60_000, 120_000, 300_000, 600_000, 900_000, undefined]);
    expect(m.llamadas()).toBe(6);
    // Los turnos de los reintentos que fallan se quitan; el aviso del primero cambia.
    expect(m.turnos.slice(1).every((t) => t.removed)).toBe(true);
    expect(nota(m.turnos[0])?.textContent).toContain('dejo de reintentarlo yo solo');
  });

  it('un mensaje nuevo o «Reintentar» cancela el reintento pendiente', async () => {
    const m = montar([sinRed]);
    await m.api.repetirUltimo();
    expect(m.vivos()).toHaveLength(1);
    m.api.cancelarReintento();
    expect(m.vivos()).toHaveLength(0);
    const html = renderPage();
    const enviarChat = html.slice(html.indexOf('async function enviarChat'));
    expect(enviarChat.indexOf('cancelarReintento();')).toBeGreaterThan(0);
    expect(enviarChat.indexOf('cancelarReintento();')).toBeLessThan(
      enviarChat.indexOf("enviar('/api/chat'"),
    );
    expect(enviarChat).toContain('programarReintento(espera, 0);');
  });

  it('una respuesta normal no programa nada', async () => {
    const m = montar([() => Promise.resolve({ text: 'hola' })]);
    await m.api.repetirUltimo();
    expect(m.vivos()).toEqual([]);
    expect(nota(m.turnos[0])).toBeUndefined();
  });
});

describe('el turno del panel dice que fue la red', () => {
  it('runPanelChat devuelve outage cuando el turno lo marca', async () => {
    const thread = { key: 'k#main', generation: 0, tail: Promise.resolve(), active: false };
    const reply = await runPanelChat(thread, 'hola', {
      remember: () => {},
      runTurn: async (_t, _s, out) => {
        out.outage?.();
        out.answer('No llego al modelo: sin conexión.');
      },
    });
    expect(reply.outage).toBe(true);
    const normal = await runPanelChat(thread, 'hola', {
      remember: () => {},
      runTurn: async (_t, _s, out) => out.answer('hola'),
    });
    expect(normal.outage).toBeUndefined();
  });

  it('el daemon lo marca solo en un fallo de red y el servidor lo deja pasar', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain(
      'if (out && autoRetryOn && !result.text.trim() && isOutageError(result.error)) out.outage?.();',
    );
    const server = readFileSync('src/webui/server.ts', 'utf8');
    expect(server).toContain('if (answer.outage === true) out.outage = true;');
  });
});
