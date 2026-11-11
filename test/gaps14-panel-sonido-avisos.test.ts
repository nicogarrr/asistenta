import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

/** El trozo del panel que lleva sonido y «Activar avisos», para correrlo con un DOM falso. */
function trozo(): string {
  const html = renderPage();
  const ini = html.indexOf("var SONIDO_CLAVE = 'asistenta-sonido-avisos';");
  const fin = html.indexOf('// Solo si Nico ya dio permiso de avisos a la página');
  expect(ini).toBeGreaterThan(0);
  expect(fin).toBeGreaterThan(ini);
  return html.slice(ini, fin);
}

interface FakeButton {
  hidden: boolean;
  textContent: string;
  title: string;
  attrs: Record<string, string>;
  handlers: Record<string, () => void>;
  setAttribute(k: string, v: string): void;
  addEventListener(ev: string, fn: () => void): void;
}
const boton = (): FakeButton => ({
  hidden: false,
  textContent: '',
  title: '',
  attrs: {},
  handlers: {},
  setAttribute(k, v) {
    this.attrs[k] = v;
  },
  addEventListener(ev, fn) {
    this.handlers[ev] = fn;
  },
});

function montar(permiso: 'default' | 'granted' | 'denied', conAudio = true) {
  const botones: Record<string, FakeButton> = {
    'activar-avisos': boton(),
    'sonido-avisos': boton(),
  };
  const docHandlers: Record<string, () => void> = {};
  const almacen = new Map<string, string>();
  const tonos: number[] = [];
  const avisos: string[] = [];
  let pedidas = 0;
  class FakeAudio {
    state = 'suspended';
    currentTime = 0;
    destination = {};
    resume() {
      this.state = 'running';
    }
    createOscillator() {
      return {
        type: '',
        frequency: { value: 0 },
        connect() {},
        start() {
          tonos.push(this.frequency.value);
        },
        stop() {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      };
    }
  }
  const Notification = {
    permission: permiso as string,
    requestPermission(cb: (p: string) => void) {
      pedidas += 1;
      Notification.permission = 'granted';
      cb('granted');
      return undefined;
    },
  };
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => botones[id] ?? null,
      addEventListener: (ev: string, fn: () => void) => {
        docHandlers[ev] = fn;
      },
    },
    window: {
      AudioContext: conAudio ? FakeAudio : undefined,
      localStorage: {
        getItem: (k: string) => almacen.get(k) ?? null,
        setItem: (k: string, v: string) => almacen.set(k, v),
      },
    },
    Notification,
    mostrarAviso: (t: string) => avisos.push(t),
  };
  runInNewContext(`${trozo()}\nthis.sonarAviso = sonarAviso;`, ctx);
  return {
    botones,
    docHandlers,
    tonos,
    avisos,
    sonar: ctx.sonarAviso as () => void,
    pedidas: () => pedidas,
  };
}

describe('gaps-14: el recordatorio del panel suena y los avisos se activan con un botón', () => {
  it('el panel lleva «🔔 Activar avisos» y «🔊 Sonido», y su script se puede leer', () => {
    const html = renderPage();
    for (const bloque of scripts(html)) expect(() => new Function(bloque)).not.toThrow();
    expect(html).toContain('id="activar-avisos"');
    expect(html).toContain('🔔 Activar avisos');
    expect(html).toContain('id="sonido-avisos"');
    expect(html).toContain('sonarAviso();');
  });

  it('no suena antes del primer toque (el navegador no deja) y sí después', () => {
    const p = montar('granted');
    p.sonar();
    expect(p.tonos).toEqual([]);
    p.docHandlers.pointerdown?.();
    p.sonar();
    expect(p.tonos).toEqual([880, 660]);
  });

  it('«🔊 Sonido» lo apaga en este navegador y se acuerda', () => {
    const p = montar('granted');
    p.docHandlers.pointerdown?.();
    expect(p.botones['sonido-avisos']?.textContent).toBe('🔊 Sonido');
    p.botones['sonido-avisos']?.handlers.click?.();
    expect(p.botones['sonido-avisos']?.textContent).toBe('🔇 Sin sonido');
    expect(p.botones['sonido-avisos']?.attrs['aria-pressed']).toBe('false');
    p.sonar();
    expect(p.tonos).toEqual([]);
    // Encenderlo otra vez suena una vez para que se oiga cómo es.
    p.botones['sonido-avisos']?.handlers.click?.();
    expect(p.tonos).toEqual([880, 660]);
  });

  it('sin WebAudio no rompe nada', () => {
    const p = montar('granted', false);
    p.docHandlers.keydown?.();
    expect(() => p.sonar()).not.toThrow();
    expect(p.tonos).toEqual([]);
  });

  it('«Activar avisos» solo sale si aún no se decidió, y pide permiso SOLO al tocarlo', () => {
    expect(montar('granted').botones['activar-avisos']?.hidden).toBe(true);
    expect(montar('denied').botones['activar-avisos']?.hidden).toBe(true);
    const p = montar('default');
    expect(p.botones['activar-avisos']?.hidden).toBe(false);
    expect(p.pedidas()).toBe(0);
    p.botones['activar-avisos']?.handlers.click?.();
    expect(p.pedidas()).toBe(1);
    expect(p.botones['activar-avisos']?.hidden).toBe(true);
    expect(p.avisos[0]).toContain('🔔 Listo');
  });
});
