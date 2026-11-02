import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

/**
 * Nico (2 nov, 13:27): el panel se quedaba en «Cargando…» para siempre. Lo servía un proceso
 * viejo que se había quedado vivo sin Asistenta detrás (#1850): las peticiones no contestaban.
 * Ahora una lectura sin respuesta en 30 s, o sin conexión, dice qué pasa y cómo arreglarlo.
 */
const NO_EN_MARCHA = 'Asistenta no está en marcha: reiníciala (bandeja → Reiniciar o pa iniciar).';

function trozo(html: string, desde: string, hasta: string): string {
  const i = html.indexOf(desde);
  expect(i).toBeGreaterThan(-1);
  const j = html.indexOf(hasta, i);
  expect(j).toBeGreaterThan(i);
  return html.slice(i, j);
}

type Fetch = (ruta: string, init: { signal?: AbortSignal; method: string }) => Promise<unknown>;

function cargar(fetch: Fetch) {
  const html = renderPage();
  const relojes: Array<() => void> = [];
  const fuente = `${trozo(html, 'async function llamar(', 'function pedir(ruta)')}\nreturn llamar;`;
  const llamar = new Function(
    'token',
    'fetch',
    'errorSinToken',
    'pedirToken',
    'formato',
    'setTimeout',
    'clearTimeout',
    fuente,
  )(
    'tok',
    fetch,
    () => new Error('sin token'),
    () => {},
    { mensajeDeError: (s: number) => `error ${s}` },
    (fn: () => void) => {
      relojes.push(fn);
      return relojes.length;
    },
    () => {},
  ) as (ruta: string, o: { metodo: string; cuerpo?: unknown }) => Promise<unknown>;
  return {
    llamar,
    vencer: () => {
      for (const fn of relojes.splice(0)) fn();
    },
  };
}

describe('panel: «Asistenta no está en marcha» en vez de «Cargando…» sin fin', () => {
  it('una lectura que no contesta se corta y lo dice', async () => {
    let señal: AbortSignal | undefined;
    const { llamar, vencer } = cargar(
      (_r, init) =>
        new Promise((_ok, ko) => {
          señal = init.signal;
          init.signal?.addEventListener('abort', () => ko(new Error('AbortError')));
        }),
    );
    const pendiente = llamar('/api/sessions', { metodo: 'GET' });
    expect(señal).toBeDefined();
    vencer();
    await expect(pendiente).rejects.toMatchObject({ message: NO_EN_MARCHA, sinConexion: true });
  });

  it('sin conexión (Asistenta apagada) dice lo mismo', async () => {
    const { llamar } = cargar(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(llamar('/api/sessions', { metodo: 'GET' })).rejects.toMatchObject({
      message: NO_EN_MARCHA,
      sinConexion: true,
    });
  });

  it('una respuesta a tiempo funciona como siempre, y las órdenes (POST) no tienen tope', async () => {
    const vistos: Array<AbortSignal | undefined> = [];
    const { llamar } = cargar(async (_r, init) => {
      vistos.push(init.signal);
      return { status: 200, ok: true, json: async () => ({ ok: 1 }) };
    });
    expect(await llamar('/api/sessions', { metodo: 'GET' })).toEqual({ ok: 1 });
    expect(await llamar('/api/chat', { metodo: 'POST', cuerpo: {} })).toEqual({ ok: 1 });
    expect(vistos[0]).toBeDefined();
    expect(vistos[1]).toBeUndefined();
  });
});
