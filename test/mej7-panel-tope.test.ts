import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';
import { renderVozPage } from '../src/webui/voz-page.js';

// Nico (6 nov): en el iPhone «hola» se quedó ~2 min en «Pensando…». /api/chat y /api/voz
// no tenían tope en el cliente: ahora cortan (90 s y 60 s) y dicen qué pasa, con «Reintentar».

function trozo(html: string, desde: string, hasta: string): string {
  const i = html.indexOf(desde);
  expect(i).toBeGreaterThan(-1);
  const j = html.indexOf(hasta, i);
  expect(j).toBeGreaterThan(i);
  return html.slice(i, j);
}

describe('panel: el chat no se queda en «Pensando…» para siempre', () => {
  it('/api/chat y /api/chat/retry piden un tope de 90 s', () => {
    const html = renderPage();
    expect(html).toContain("enviar('/api/chat', { text: texto }, 90000");
    expect(html).toContain("enviar('/api/chat/retry', {}, 90000)");
  });

  it('un POST con tope se corta a los 90 s con un error claro', async () => {
    const html = renderPage();
    const fuente = `${trozo(html, 'async function llamar(', 'function pedir(ruta)')}\nreturn llamar;`;
    const relojes: Array<{ fn: () => void; ms: number }> = [];
    let señal: AbortSignal | undefined;
    const fetch = (_r: string, init: { signal?: AbortSignal }) =>
      new Promise((_ok, ko) => {
        señal = init.signal;
        init.signal?.addEventListener('abort', () => ko(new Error('abort')));
      });
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
      (fn: () => void, ms: number) => {
        relojes.push({ fn, ms });
        return relojes.length;
      },
      () => {},
    ) as (ruta: string, o: { metodo: string; cuerpo?: unknown; tope?: number }) => Promise<unknown>;
    const p = llamar('/api/chat', { metodo: 'POST', cuerpo: { text: 'hola' }, tope: 90000 });
    expect(señal).toBeDefined();
    expect(relojes.map((r) => r.ms)).toEqual([90000]);
    for (const r of relojes) r.fn();
    const error = (await p.catch((e) => e)) as Error & {
      tiempoAgotado?: boolean;
      sinConexion?: boolean;
    };
    expect(error.message).toContain('más de 90 s sin contestar');
    expect(error.message).toContain('«Reintentar»');
    expect(error.tiempoAgotado).toBe(true);
    expect(error.sinConexion).toBeUndefined();
  });
});

describe('/voz: tope de 60 s y botón «Reintentar»', () => {
  it('corta /api/voz a los 60 s y ofrece reintentar con el mismo audio', () => {
    const html = renderVozPage();
    expect(html).toContain('<button id="reintentar" type="button" hidden>Reintentar</button>');
    expect(html).toContain('var TOPE_VOZ_MS = 60000;');
    const mandar = trozo(html, 'function mandar(audio, mime)', "boton.addEventListener('click'");
    expect(mandar).toContain('signal: corte ? corte.signal : undefined');
    expect(mandar).toContain('corte.abort()');
    expect(mandar).toContain('sin contestar');
    expect(mandar).toContain('mandar(audio, mime)');
  });
});
