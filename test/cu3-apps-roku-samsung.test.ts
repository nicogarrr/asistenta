/**
 * Apps en Roku y Samsung (asis-computeruse-3):
 * - «abre YouTube» / «abre Prime Video» llegaban con el nombre dicho
 *   («youtube», «prime video») y el driver solo conocía el id de LG: «No sé
 *   abrir «youtube»».
 * - Cualquier app fuera de las seis conocidas («abre RTVE Play») no se podía
 *   abrir: ahora se busca en la lista REAL de la tele (Roku /query/apps,
 *   Samsung ed.installedApp.get), guardada por tele (app-cache.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvAppCache } from '../src/tv/app-cache.js';
import { lgAppIdFor, matchInstalledApp } from '../src/tv/driver-apps.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver, rokuInstalledApps, rokuSearchPath } from '../src/tv/roku.js';
import { type SamsungSocket, samsungDriver, samsungInstalledApps } from '../src/tv/samsung.js';

const ROKU_APPS = `<?xml version="1.0" encoding="UTF-8" ?>
<apps>
  <app id="12" type="appl" version="5.1.0">Netflix</app>
  <app id="837" type="appl" version="2.1.0">YouTube</app>
  <app id="tvinput.hdmi1" type="tvin" version="1.0.0">HDMI 1</app>
  <app id="593099" type="appl" version="1.2.0">RTVE Play</app>
  <app id="61322" type="appl" version="7.0.1">HBO Max &amp; más</app>
</apps>`;

function fakeRoku(delayMs = 0) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u.replace('http://192.168.1.60:8060', '')}`);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(u.endsWith('/query/apps') ? ROKU_APPS : '', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Samsung falsa: acepta el canal y contesta ed.installedApp.get con su lista. */
function fakeSamsung(apps: Array<{ appId: string; name: string; app_type: number }>) {
  const sent: string[] = [];
  let opened = 0;
  const factory = (): SamsungSocket => {
    opened++;
    const handlers: Record<string, ((x?: unknown) => void)[]> = {};
    const emit = (msg: object) => {
      for (const cb of handlers.message ?? []) cb(JSON.stringify(msg));
    };
    setTimeout(() => emit({ event: 'ms.channel.connect', data: {} }), 2);
    return {
      on: (ev: string, cb: (x?: unknown) => void) => {
        const list = handlers[ev] ?? [];
        list.push(cb);
        handlers[ev] = list;
      },
      send: (d: string) => {
        sent.push(d);
        const p = (JSON.parse(d) as { params?: { event?: string } }).params;
        if (p?.event === 'ed.installedApp.get') {
          setTimeout(() => emit({ event: 'ed.installedApp.get', data: { data: apps } }), 2);
        }
      },
      close: () => {},
    } as unknown as SamsungSocket;
  };
  const launched = () =>
    sent
      .map((s) => JSON.parse(s) as { params?: { event?: string; data?: Record<string, string> } })
      .filter((m) => m.params?.event === 'ed.apps.launch')
      .map((m) => m.params?.data);
  return { factory, sent, launched, opened: () => opened };
}
const conn = { host: '192.168.1.61', secure: false };

describe('el nombre dicho llega al id de la marca', () => {
  it('lgAppIdFor y matchInstalledApp', () => {
    expect(lgAppIdFor('prime video')).toBe('amazon');
    expect(lgAppIdFor('youtube')).toBe('youtube.leanback.v4');
    expect(lgAppIdFor('netflix')).toBe('netflix');
    expect(lgAppIdFor('rtve play')).toBe('rtve play');
    const list = [
      { id: '593099', title: 'RTVE Play' },
      { id: '3201910019365', title: 'Prime Video' },
    ];
    expect(matchInstalledApp('rtve play', list)?.id).toBe('593099');
    // «amazon» (alias) → título «Prime Video» de la lista.
    expect(matchInstalledApp('amazon', list)?.id).toBe('3201910019365');
    expect(matchInstalledApp('plex', list)).toBeNull();
  });

  it('Roku: «abre YouTube» y «abre Prime Video» (antes: «No sé abrir»)', async () => {
    const { calls, fetchImpl } = fakeRoku();
    const d = rokuDriver('192.168.1.60', { fetchImpl });
    for (const text of ['abre YouTube en la tele', 'abre Prime Video en la tele']) {
      const intent = parseTvCommand(text);
      if (!intent) throw new Error(text);
      await runIntentOnDriver(d, intent);
    }
    // Tras abrir, se mira que la app salga en pantalla (/query/active-app).
    expect(calls).toEqual([
      'POST /launch/837',
      'GET /query/active-app',
      'POST /launch/13',
      'GET /query/active-app',
    ]);
  });

  it('Samsung: «abre YouTube» sin pedir la lista', async () => {
    const tv = fakeSamsung([]);
    const d = samsungDriver(conn, { socketFactory: tv.factory, graceMs: 0 });
    await d.launch?.('youtube');
    expect(tv.launched()).toEqual([{ appId: '111299001912', action_type: 'DEEP_LINK' }]);
  });

  it('Roku: buscar con el nombre dicho también usa su canal', () => {
    expect(rokuSearchPath('bailando', 'youtube')).toContain('provider-id=837');
  });
});

describe('lista real de apps instaladas', () => {
  it('Roku: /query/apps (sin entradas HDMI raras, con &amp;)', async () => {
    const { fetchImpl } = fakeRoku();
    const apps = await rokuInstalledApps('192.168.1.60', { fetchImpl });
    expect(apps).toContainEqual({ id: '593099', title: 'RTVE Play' });
    expect(apps).toContainEqual({ id: '61322', title: 'HBO Max & más' });
  });

  it('Samsung: ed.installedApp.get', async () => {
    const tv = fakeSamsung([
      { appId: '3201908019041', name: 'RTVE Play', app_type: 2 },
      { appId: 'org.tizen.browser', name: 'Internet', app_type: 4 },
    ]);
    const apps = await samsungInstalledApps(conn, { socketFactory: tv.factory });
    expect(apps).toEqual([
      { id: '3201908019041', title: 'RTVE Play' },
      { id: 'org.tizen.browser', title: 'Internet' },
    ]);
  });

  it('Samsung: «abre RTVE Play» y «abre internet» con la lista (tienda: DEEP_LINK; Tizen: NATIVE)', async () => {
    const tv = fakeSamsung([
      { appId: '3201908019041', name: 'RTVE Play', app_type: 2 },
      { appId: 'org.tizen.browser', name: 'Internet', app_type: 4 },
    ]);
    const d = samsungDriver(conn, { socketFactory: tv.factory, graceMs: 0 });
    await d.launch?.('rtve play');
    await d.launch?.('internet');
    expect(tv.launched()).toEqual([
      { appId: '3201908019041', action_type: 'DEEP_LINK' },
      { appId: 'org.tizen.browser', action_type: 'NATIVE_LAUNCH' },
    ]);
  });

  it('una app que no está: lo dice con lo que SÍ tiene, sin tocar la tele', async () => {
    const { calls, fetchImpl } = fakeRoku();
    const d = rokuDriver('192.168.1.60', { fetchImpl });
    await expect(d.launch?.('plex')).rejects.toThrow(
      /No encuentro «plex» en el Roku\. Tiene: .*RTVE Play/,
    );
    expect(calls).toEqual(['GET /query/apps']);
  });

  it('Roku: «abre RTVE Play» la 2.ª vez no vuelve a pedir la lista (antes: imposible)', async () => {
    const { calls, fetchImpl } = fakeRoku(40);
    const cache = createTvAppCache({});
    const d = rokuDriver('192.168.1.60', {
      fetchImpl,
      installedApps: () =>
        cache.get('192.168.1.60', () => rokuInstalledApps('192.168.1.60', { fetchImpl })),
    });
    const t0 = performance.now();
    await d.launch?.('rtve play');
    const first = performance.now() - t0;
    const t1 = performance.now();
    await d.launch?.('rtve play');
    const second = performance.now() - t1;
    expect(calls).toEqual([
      'GET /query/apps',
      'POST /launch/593099',
      'GET /query/active-app',
      'POST /launch/593099',
      'GET /query/active-app',
    ]);
    // 2 peticiones la 1.ª vez, 1 la 2.ª (fakes de 40 ms por petición).
    expect(second).toBeLessThan(first);
    console.log(`roku «abre RTVE Play»: 1.ª ${first.toFixed(0)} ms, 2.ª ${second.toFixed(0)} ms`);
  });
});
