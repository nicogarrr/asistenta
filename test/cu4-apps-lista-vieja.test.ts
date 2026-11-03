/**
 * Roku y Samsung con la lista de apps guardada (12 h, #1937): una app recién
 * instalada no estaba en ella y «abre RTVE Play» contestaba «No encuentro» hasta
 * medio día después. La LG ya volvía a pedir la lista (resolveTvApp); ahora
 * también ellas, una sola vez (asis-computeruse-4, casos límite de #1937).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvAppCache } from '../src/tv/app-cache.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver } from '../src/tv/roku.js';
import { type SamsungSocket, samsungDriver } from '../src/tv/samsung.js';

const OLD = [{ id: '12', title: 'Netflix' }];
const NEW = [...OLD, { id: '593099', title: 'RTVE Play' }];
const intentOf = (t: string) => {
  const i = parseTvCommand(t);
  if (!i) throw new Error(t);
  return i;
};

function fakeRoku() {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('lista de apps guardada y vieja', () => {
  it('Roku: app recién instalada → pide la lista otra vez (1 vez) y la abre', async () => {
    let tvList = OLD;
    const loader = vi.fn(async () => tvList);
    const cache = createTvAppCache({ now: () => 1000 });
    await cache.get('192.168.1.60', loader); // guardada sin RTVE Play
    tvList = NEW; // Nico la instala
    const { calls, fetchImpl } = fakeRoku();
    const d = rokuDriver('192.168.1.60', {
      fetchImpl,
      installedApps: (o) => cache.get('192.168.1.60', loader, o),
    });
    await runIntentOnDriver(d, intentOf('abre RTVE Play en la tele'));
    expect(calls).toEqual(['POST /launch/593099']);
    expect(loader).toHaveBeenCalledTimes(2);
    // La siguiente vez ya sale de la lista guardada: ninguna petición de lista.
    await runIntentOnDriver(d, intentOf('abre RTVE Play en la tele'));
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('Roku: una app que de verdad no está pide la lista fresca una sola vez y lo dice', async () => {
    const loader = vi.fn(async () => OLD);
    const cache = createTvAppCache({ now: () => 1000 });
    const { fetchImpl } = fakeRoku();
    const d = rokuDriver('192.168.1.60', {
      fetchImpl,
      installedApps: (o) => cache.get('192.168.1.60', loader, o),
    });
    await expect(runIntentOnDriver(d, intentOf('abre Plex en la tele'))).rejects.toThrow(
      /No encuentro «plex» en el Roku\. Tiene: Netflix/,
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('Samsung: igual, con la lista guardada vieja', async () => {
    const sent: string[] = [];
    const factory = (): SamsungSocket => {
      const h: Record<string, Array<(x?: unknown) => void>> = {};
      setTimeout(() => {
        for (const fn of h.message ?? [])
          fn(JSON.stringify({ event: 'ms.channel.connect', data: {} }));
      }, 1);
      return {
        on: (ev: string, fn: (x?: unknown) => void) => {
          if (!h[ev]) h[ev] = [];
          h[ev].push(fn);
        },
        send: (s: string) => sent.push(s),
        close: () => {},
      } as unknown as SamsungSocket;
    };
    const installedApps = vi.fn(async (o?: { fresh?: boolean }) => (o?.fresh ? NEW : OLD));
    const d = samsungDriver(
      { host: '192.168.1.61', secure: false },
      { socketFactory: factory, graceMs: 0, installedApps },
    );
    await runIntentOnDriver(d, intentOf('abre RTVE Play en la tele'));
    expect(installedApps).toHaveBeenCalledTimes(2);
    expect(installedApps).toHaveBeenLastCalledWith({ fresh: true });
    const launched = sent
      .map((s) => JSON.parse(s) as { params?: { event?: string; data?: { appId?: string } } })
      .filter((m) => m.params?.event === 'ed.apps.launch')
      .map((m) => m.params?.data?.appId);
    expect(launched).toEqual(['593099']);
  });

  it('sin lista guardada (pa tv en consola) no repite la petición', async () => {
    const { calls, fetchImpl } = fakeRoku();
    const d = rokuDriver('192.168.1.60', { fetchImpl });
    await expect(runIntentOnDriver(d, intentOf('abre Plex en la tele'))).rejects.toThrow();
    expect(calls.filter((c) => c.endsWith('/query/apps'))).toHaveLength(1);
  });
});
