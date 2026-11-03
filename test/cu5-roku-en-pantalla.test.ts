/**
 * Roku: tras abrir una app se comprueba con /query/active-app que ha salido
 * en pantalla y se dice en la respuesta (asis-computeruse-5, pista 1 de
 * cu4/HANDOFF.md). El Roku no da captura: antes «Roku: abriendo netflix.» se
 * decía sin mirar, aunque la app no llegara a abrirse. Con fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { rokuActiveApp, rokuDriver } from '../src/tv/roku.js';

const HOST = '192.168.1.60';
const HOME = '<active-app><app>Roku</app></active-app>';
const app = (id: string, title: string) =>
  `<active-app><app id="${id}" type="appl" version="5.1">${title}</app><screensaver id="5533" type="ssvr">Roku Digital Clock</screensaver></active-app>`;

/** Roku de mentira: `screens` es lo que va diciendo /query/active-app, una respuesta por consulta. */
function fakeRoku(screens: string[]) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/query/active-app') return new Response(screens.shift() ?? screens.at(-1) ?? '');
    return new Response('');
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const fast = { confirmMs: 50, confirmStepMs: 1, sleep: async () => {} };

describe('rokuActiveApp', () => {
  it('lee la app en pantalla; en el inicio no hay id', async () => {
    expect(
      await rokuActiveApp(HOST, { fetchImpl: fakeRoku([app('12', 'Netflix')]).fetchImpl }),
    ).toEqual({
      id: '12',
      title: 'Netflix',
    });
    expect(await rokuActiveApp(HOST, { fetchImpl: fakeRoku([HOME]).fetchImpl })).toEqual({
      id: null,
      title: 'Roku',
    });
    expect(await rokuActiveApp(HOST, { fetchImpl: fakeRoku(['']).fetchImpl })).toBeNull();
  });
});

describe('Roku: abrir una app y comprobarlo en pantalla', () => {
  it('sale enseguida: lo dice comprobado', async () => {
    const r = fakeRoku([app('12', 'Netflix')]);
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, ...fast });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(said).toBe('Roku: Netflix abierto; comprobado, está en pantalla.');
    expect(r.calls).toEqual(['POST /launch/12', 'GET /query/active-app']);
  });

  it('tarda en arrancar: espera hasta verla (inicio → Netflix)', async () => {
    const r = fakeRoku([HOME, HOME, app('12', 'Netflix')]);
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, ...fast });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(said).toMatch(/Netflix abierto; comprobado/);
    expect(r.calls.filter((c) => c === 'GET /query/active-app')).toHaveLength(3);
  });

  it('no llega a salir: dice lo que hay en pantalla, sin «abriendo» falso', async () => {
    const r = fakeRoku([HOME]);
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, confirmMs: 0, sleep: async () => {} });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(said).toBe(
      'Roku: he pedido abrir netflix, pero en pantalla sigue «Roku»; puede estar tardando o no haberse abierto.',
    );
  });

  it('el Roku no lo dice (respuesta rara o error): la respuesta de siempre', async () => {
    const r = fakeRoku(['']);
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, ...fast });
    expect(await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' })).toBe(
      'Roku: abriendo netflix.',
    );
  });

  it('vídeo de YouTube por enlace: comprueba que YouTube está en pantalla', async () => {
    const r = fakeRoku([app('837', 'YouTube')]);
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, ...fast });
    const said = await runIntentOnDriver(d, {
      action: 'search',
      text: 'https://youtu.be/dQw4w9WgXcQ',
      appId: 'youtube.leanback.v4',
    });
    expect(said).toBe('Roku: YouTube abierto; comprobado, está en pantalla.');
  });

  it('buscar texto (pantalla de búsqueda del Roku) no espera ninguna app', async () => {
    const r = fakeRoku([HOME]);
    const d = rokuDriver(HOST, { fetchImpl: r.fetchImpl, ...fast });
    expect(await runIntentOnDriver(d, { action: 'search', text: 'dune', appId: 'netflix' })).toBe(
      'Roku: buscando «dune».',
    );
    expect(r.calls.some((c) => c.includes('active-app'))).toBe(false);
  });
});
