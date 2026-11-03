/**
 * Roku: «¿qué está viendo la tele?» contestaba «La Roku no deja leer qué está
 * viendo desde Asistenta», pero el ECP sí lo dice: /query/active-app (qué app),
 * /query/media-player (si reproduce y por dónde) y /query/device-info (reposo).
 * Ahora lo contesta (asis-computeruse-6). Con fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { runIntentOnDriver, type TvDriver } from '../src/tv/drivers.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver, rokuStatus } from '../src/tv/roku.js';

type Routes = Record<string, string | number | Error>;
function fakeRoku(routes: Routes) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const r = routes[path];
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('', { status: r });
    return new Response(r ?? '', { status: r === undefined ? 404 : 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ON = '<device-info><power-mode>PowerOn</power-mode></device-info>';
const NETFLIX = '<active-app><app id="12" type="appl" version="5.1">Netflix</app></active-app>';
const PLAYING =
  '<player error="false" state="play"><plugin id="12" name="Netflix"/><position>123456 ms</position><duration>2700000 ms</duration></player>';
const host = '192.168.1.80';

describe('Roku: qué hay en pantalla', () => {
  it('la orden «qué está viendo» llega al Roku y dice la app y por dónde va', async () => {
    const roku = fakeRoku({
      '/query/device-info': ON,
      '/query/active-app': NETFLIX,
      '/query/media-player': PLAYING,
    });
    const intent = parseTvCommand('qué está viendo la tele');
    expect(intent).toEqual({ action: 'status' });
    const said = await runIntentOnDriver(rokuDriver(host, { fetchImpl: roku.fetchImpl }), {
      action: 'status',
    });
    expect(said).toBe('Roku: en pantalla está Netflix (reproduciendo, 2:03 de 45:00).');
    // Solo consultas: nada de pulsar teclas.
    expect(roku.calls.every((c) => c.startsWith('GET /query/'))).toBe(true);
  });

  it('en pausa con más de una hora; sin posición, solo el estado', async () => {
    const paused = fakeRoku({
      '/query/device-info': ON,
      '/query/active-app': NETFLIX,
      '/query/media-player':
        '<player state="pause"><position>3723000 ms</position><duration>7200000 ms</duration></player>',
    });
    expect(await rokuStatus(host, { fetchImpl: paused.fetchImpl })).toBe(
      'Roku: en pantalla está Netflix (en pausa, 1:02:03 de 2:00:00).',
    );
    const noPos = fakeRoku({
      '/query/device-info': ON,
      '/query/active-app': NETFLIX,
      '/query/media-player': '<player state="play"/>',
    });
    expect(await rokuStatus(host, { fetchImpl: noPos.fetchImpl })).toBe(
      'Roku: en pantalla está Netflix (reproduciendo).',
    );
  });

  it('app sin vídeo o reproductor que falla → solo la app', async () => {
    for (const player of ['<player error="false" state="close"/>', 500, new Error('x')]) {
      const roku = fakeRoku({
        '/query/device-info': ON,
        '/query/active-app':
          '<active-app><app id="291097" type="appl">Disney Plus &amp; Star</app></active-app>',
        '/query/media-player': player,
      });
      expect(await rokuStatus(host, { fetchImpl: roku.fetchImpl })).toBe(
        'Roku: en pantalla está Disney Plus & Star.',
      );
    }
  });

  it('en el inicio (con o sin salvapantallas) no pregunta al reproductor', async () => {
    const home = fakeRoku({
      '/query/device-info': ON,
      '/query/active-app': '<active-app><app>Roku</app></active-app>',
    });
    expect(await rokuStatus(host, { fetchImpl: home.fetchImpl })).toBe(
      'Roku: está en el inicio, sin ninguna app abierta.',
    );
    expect(home.calls).not.toContain('GET /query/media-player');
    const saver = fakeRoku({
      '/query/device-info': ON,
      '/query/active-app':
        '<active-app><app>Roku</app><screensaver id="55545" type="ssvr">Default screensaver</screensaver></active-app>',
    });
    expect(await rokuStatus(host, { fetchImpl: saver.fetchImpl })).toBe(
      'Roku: está en el inicio, sin ninguna app abierta, con el salvapantallas puesto.',
    );
  });

  it('Roku TV en reposo (pantalla apagada) lo dice', async () => {
    for (const mode of ['DisplayOff', 'Ready']) {
      const roku = fakeRoku({
        '/query/device-info': `<device-info><power-mode>${mode}</power-mode></device-info>`,
        '/query/active-app': NETFLIX,
      });
      expect(await rokuStatus(host, { fetchImpl: roku.fetchImpl })).toBe(
        'Roku: está en reposo (pantalla apagada).',
      );
    }
  });

  it('device-info raro no impide contestar; apagado del todo → «No llego al Roku»', async () => {
    const odd = fakeRoku({
      '/query/device-info': 500,
      '/query/active-app': NETFLIX,
      '/query/media-player': '',
    });
    expect(await rokuStatus(host, { fetchImpl: odd.fetchImpl })).toBe(
      'Roku: en pantalla está Netflix.',
    );
    const off = fakeRoku({ '/query/device-info': new Error('ETIMEDOUT') });
    await expect(rokuStatus(host, { fetchImpl: off.fetchImpl })).rejects.toThrow(
      /No llego al Roku/,
    );
    const weird = fakeRoku({ '/query/device-info': ON, '/query/active-app': '<html/>' });
    await expect(rokuStatus(host, { fetchImpl: weird.fetchImpl })).rejects.toThrow(
      'El Roku no dice qué hay en pantalla.',
    );
  });

  it('una tele sin estado (Samsung) sigue diciendo que no lo deja leer', async () => {
    const d: TvDriver = {
      brand: 'Samsung',
      power: async () => {},
      volumeStep: async () => {},
      mute: async () => undefined,
      key: async () => {},
    };
    await expect(runIntentOnDriver(d, { action: 'status' })).rejects.toThrow(
      /no deja leer qué está viendo/,
    );
  });
});
