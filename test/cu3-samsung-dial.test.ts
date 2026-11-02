/**
 * Samsung: buscar dentro de Netflix y poner un vídeo de YouTube por DIAL
 * (asis-computeruse-3). Antes «busca Dune en Netflix» o «pon en YouTube
 * <enlace>» en una Samsung contestaban «La Samsung no deja buscar dentro de
 * las apps». DIAL es el protocolo con el que el móvil manda Netflix o YouTube
 * a la tele: un POST a http://IP:8080/ws/apps/<App>.
 */
import { describe, expect, it, vi } from 'vitest';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { parseTvCommand } from '../src/tv/natural.js';
import {
  type SamsungSocket,
  samsungDialLaunch,
  samsungDriver,
  youtubeVideoId,
} from '../src/tv/samsung.js';

const conn = { host: '192.168.1.61', secure: false };
function fakeDial(status = 201, delayMs = 0) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const noSocket = (() => {
  throw new Error('no debe abrir el WebSocket');
}) as unknown as (url: string) => SamsungSocket;

describe('Samsung: búsqueda por DIAL', () => {
  it('«busca Dune en Netflix en la tele» → 1 POST DIAL a Netflix con la búsqueda', async () => {
    const { calls, fetchImpl } = fakeDial();
    const d = samsungDriver(conn, { fetchImpl, socketFactory: noSocket });
    const intent = parseTvCommand('busca Dune en Netflix en la tele');
    if (!intent) throw new Error('sin intent');
    const said = await runIntentOnDriver(d, intent);
    expect(said).toBe('Samsung: buscando «dune».');
    expect(calls).toEqual([
      {
        url: 'http://192.168.1.61:8080/ws/apps/Netflix',
        body: 'm=https://www.netflix.com/search?q=dune&source_type=4',
      },
    ]);
  });

  it('tildes y ñ van codificadas', async () => {
    const { calls, fetchImpl } = fakeDial();
    const d = samsungDriver(conn, { fetchImpl, socketFactory: noSocket });
    await d.search?.('el año que vivimos', 'netflix');
    expect(calls[0]?.body).toBe(
      `m=https://www.netflix.com/search?q=${encodeURIComponent('el año que vivimos')}&source_type=4`,
    );
  });

  it('«pon en YouTube <enlace>» → DIAL v=ID (el id con sus mayúsculas)', async () => {
    const intent = parseTvCommand('pon en YouTube https://youtu.be/dQw4w9WgXcQ');
    expect(intent).toEqual({
      action: 'search',
      text: 'https://youtu.be/dQw4w9WgXcQ',
      appId: 'youtube.leanback.v4',
    });
    const { calls, fetchImpl } = fakeDial();
    const d = samsungDriver(conn, { fetchImpl, socketFactory: noSocket });
    if (!intent) throw new Error('sin intent');
    await runIntentOnDriver(d, intent);
    expect(calls).toEqual([
      { url: 'http://192.168.1.61:8080/ws/apps/YouTube', body: 'v=dQw4w9WgXcQ' },
    ]);
  });

  it('youtubeVideoId: enlaces habituales y texto', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('https://youtube.com/shorts/abcdefghijk')).toBe('abcdefghijk');
    expect(youtubeVideoId('v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoId('bailando de enrique iglesias')).toBeNull();
  });

  it('texto en YouTube: lo dice claro y no toca la tele', async () => {
    const { calls, fetchImpl } = fakeDial();
    const d = samsungDriver(conn, { fetchImpl, socketFactory: noSocket });
    await expect(d.search?.('bailando', 'youtube.leanback.v4')).rejects.toThrow(
      /no deja buscar texto dentro de YouTube/,
    );
    expect(calls).toEqual([]);
  });

  it('la tele contesta un error o no llega: mensaje claro', async () => {
    const d = samsungDriver(conn, { fetchImpl: fakeDial(404).fetchImpl, socketFactory: noSocket });
    await expect(d.search?.('dune', 'netflix')).rejects.toThrow(/DIAL 404/);
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      samsungDialLaunch('192.168.1.61', 'Netflix', 'm=x', { fetchImpl: down }),
    ).rejects.toThrow(/No llego a la Samsung por DIAL/);
  });

  it('solo IPs privadas', async () => {
    const { fetchImpl } = fakeDial();
    await expect(samsungDialLaunch('8.8.8.8', 'Netflix', 'm=x', { fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tiempo con fakes (40 ms por petición): 1 sola petición', async () => {
    const { calls, fetchImpl } = fakeDial(201, 40);
    const d = samsungDriver(conn, { fetchImpl, socketFactory: noSocket });
    const t0 = performance.now();
    await d.search?.('dune', 'netflix');
    const ms = performance.now() - t0;
    expect(calls).toHaveLength(1);
    console.log(`samsung «busca Dune en Netflix»: ${ms.toFixed(0)} ms`);
  });
});
