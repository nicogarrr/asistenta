/**
 * Samsung: un id de app guardado que ya no existe en la tele (app
 * desinstalada, o el id de la tienda es otro en este modelo). Antes la tele
 * no hacía nada y Asistenta decía «abriendo…» igual; la lista guardada (12 h)
 * seguía dando el id viejo. Ahora se lee el acuse de «ed.apps.launch»: con un
 * código de error se pide la lista fresca y se abre el id bueno, o se dice que
 * ya no está (asis-computeruse-5, pista 3 de cu4/HANDOFF.md). Con fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvAppCache } from '../src/tv/app-cache.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { SamsungSessionPool, type SamsungSocket, samsungDriver } from '../src/tv/samsung.js';

/** Tele de mentira: `ack(appId)` decide qué contesta a «ed.apps.launch» (undefined = nada). */
function fakeTv(ack: (appId: string) => number | undefined) {
  const launched: string[] = [];
  let opened = 0;
  const factory = (): SamsungSocket => {
    opened++;
    const h: Record<string, Array<(x?: unknown) => void>> = {};
    const emit = (msg: object) => {
      for (const fn of h.message ?? []) fn(JSON.stringify(msg));
    };
    setTimeout(() => emit({ event: 'ms.channel.connect', data: {} }), 1);
    return {
      on: (ev: string, fn: (x?: unknown) => void) => {
        if (!h[ev]) h[ev] = [];
        h[ev].push(fn);
      },
      send: (s: string) => {
        const m = JSON.parse(s) as { params?: { event?: string; data?: { appId?: string } } };
        if (m.params?.event !== 'ed.apps.launch') return;
        const id = m.params.data?.appId ?? '';
        launched.push(id);
        const code = ack(id);
        if (code !== undefined)
          setTimeout(() => emit({ event: 'ed.apps.launch', data: code, from: 'host' }), 2);
      },
      close: () => {},
    } as unknown as SamsungSocket;
  };
  return { launched, factory, opened: () => opened };
}

const NETFLIX = { id: '3201907018807', title: 'Netflix' };
let n = 0;
/** Cada caso con su IP: «esta tele no acusa» se recuerda por tele. */
const conn = () => ({ host: `192.168.1.${100 + n++}`, secure: false });

describe('Samsung: id de app guardado que ya no existe', () => {
  it('la tele acusa 200: una sola orden, sin pedir la lista otra vez', async () => {
    const tv = fakeTv(() => 200);
    const loader = vi.fn(async () => [NETFLIX, { id: '111', title: 'RTVE Play' }]);
    const d = samsungDriver(conn(), { socketFactory: tv.factory, installedApps: loader });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'rtve play' });
    expect(tv.launched).toEqual(['111']);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(said).toBe('Samsung: abriendo rtve play.');
  });

  it('id viejo de la lista guardada → 404 → lista fresca y abre el id nuevo', async () => {
    const c = conn();
    const tv = fakeTv((id) => (id === 'viejo' ? 404 : 200));
    let tvList = [NETFLIX, { id: 'viejo', title: 'RTVE Play' }];
    const loader = vi.fn(async () => tvList);
    const cache = createTvAppCache({ now: () => 1000 });
    await cache.get(c.host, loader); // guardada con el id viejo
    tvList = [NETFLIX, { id: 'nuevo', title: 'RTVE Play' }]; // reinstalada con otro id
    const d = samsungDriver(c, {
      socketFactory: tv.factory,
      installedApps: (o) => cache.get(c.host, loader, o),
    });
    await runIntentOnDriver(d, { action: 'launch', appId: 'rtve play' });
    expect(tv.launched).toEqual(['viejo', 'nuevo']);
    // La caché queda con el id bueno: la próxima vez, a la primera.
    tv.launched.length = 0;
    await runIntentOnDriver(d, { action: 'launch', appId: 'rtve play' });
    expect(tv.launched).toEqual(['nuevo']);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('app desinstalada: lo dice con la lista real, sin «abriendo»', async () => {
    const tv = fakeTv((id) => (id === 'viejo' ? 404 : 200));
    let calls = 0;
    const loader = vi.fn(async () =>
      calls++ === 0 ? [NETFLIX, { id: 'viejo', title: 'RTVE Play' }] : [NETFLIX],
    );
    const d = samsungDriver(conn(), { socketFactory: tv.factory, installedApps: loader });
    await expect(runIntentOnDriver(d, { action: 'launch', appId: 'rtve play' })).rejects.toThrow(
      /«rtve play» ya no está en la Samsung \(¿la desinstalaste\?\)\. Tiene: Netflix\./,
    );
    expect(tv.launched).toEqual(['viejo']);
  });

  it('el id de tienda de Netflix no es el de esta tele → abre el de su lista', async () => {
    const tv = fakeTv((id) => (id === NETFLIX.id ? 404 : 200));
    const loader = vi.fn(async () => [{ id: '11101200001', title: 'Netflix' }]);
    const d = samsungDriver(conn(), { socketFactory: tv.factory, installedApps: loader });
    await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(tv.launched).toEqual([NETFLIX.id, '11101200001']);
    expect(loader).toHaveBeenCalledWith({ fresh: true });
  });

  it('una tele que nunca acusa: se espera una vez y luego manda y sigue (como antes)', async () => {
    const tv = fakeTv(() => undefined);
    const d = samsungDriver(conn(), {
      socketFactory: tv.factory,
      launchAckMs: 60,
      graceMs: 0,
      installedApps: async () => [NETFLIX],
    });
    const t0 = performance.now();
    await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    const first = performance.now() - t0;
    const t1 = performance.now();
    await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    const second = performance.now() - t1;
    expect(tv.launched).toEqual([NETFLIX.id, NETFLIX.id]);
    expect(first).toBeGreaterThanOrEqual(55);
    expect(second).toBeLessThan(50);
  });

  it('con la conexión persistente (daemon) el acuse llega por la misma conexión', async () => {
    const tv = fakeTv((id) => (id === 'viejo' ? 404 : 200));
    let calls = 0;
    const loader = vi.fn(async () =>
      calls++ === 0 ? [{ id: 'viejo', title: 'RTVE Play' }] : [{ id: 'nuevo', title: 'RTVE Play' }],
    );
    const pool = new SamsungSessionPool({ idleMs: 60_000 });
    const d = samsungDriver(conn(), { socketFactory: tv.factory, installedApps: loader, pool });
    const t0 = performance.now();
    await runIntentOnDriver(d, { action: 'launch', appId: 'rtve play' });
    expect(performance.now() - t0).toBeLessThan(300);
    expect(tv.launched).toEqual(['viejo', 'nuevo']);
    expect(tv.opened()).toBe(1);
    pool.closeAll();
  });
});
