/**
 * Samsung: tras abrir una app, la tele confirma si está en pantalla. Antes
 * decía «Samsung: abriendo netflix.» sin mirar (la Samsung no da captura); ahora
 * pregunta GET :8001/api/v2/applications/<id> (`visible`) cada 0,5 s, tope 3 s,
 * como el Roku con /query/active-app (#1961). Respuesta rara o error → la
 * frase de siempre (asis-computeruse-6, pista 1 de cu5/HANDOFF.md). Con fakes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { type SamsungSocket, samsungAppStatus, samsungDriver } from '../src/tv/samsung.js';

/** Tele que acusa 200 a «ed.apps.launch» y apunta qué se abrió. */
function fakeSocket() {
  const launched: string[] = [];
  const factory = (): SamsungSocket => {
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
        launched.push(m.params.data?.appId ?? '');
        setTimeout(() => emit({ event: 'ed.apps.launch', data: 200 }), 2);
      },
      close: () => {},
    } as unknown as SamsungSocket;
  };
  return { launched, factory };
}

/** REST de mentira: `status(n)` es la respuesta de la n-ésima consulta (0, 1…). */
function fakeRest(status: (n: number, url: string) => Response | Error) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes(':8080/ws/apps/')) return new Response('', { status: 201 });
    urls.push(u);
    const r = status(urls.length - 1, u);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 });
const conn = { host: '192.168.1.60', secure: false };
const fast = { confirmMs: 3000, confirmStepMs: 1, sleep: async () => {} };

describe('Samsung: app en pantalla tras abrirla', () => {
  it('visible a la segunda consulta → «abierto; comprobado, está en pantalla»', async () => {
    const tv = fakeSocket();
    const rest = fakeRest((n) =>
      json({ id: '3201907018807', name: 'Netflix', running: n > 0, visible: n > 0 }),
    );
    const d = samsungDriver(conn, {
      socketFactory: tv.factory,
      fetchImpl: rest.fetchImpl,
      ...fast,
    });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(tv.launched).toEqual(['3201907018807']);
    expect(rest.urls).toEqual([
      'http://192.168.1.60:8001/api/v2/applications/3201907018807',
      'http://192.168.1.60:8001/api/v2/applications/3201907018807',
    ]);
    expect(said).toBe('Samsung: Netflix abierto; comprobado, está en pantalla.');
  });

  it('nunca visible en el tope → lo dice sin afirmar que se abrió', async () => {
    const tv = fakeSocket();
    const rest = fakeRest(() => json({ name: 'Netflix', running: false, visible: false }));
    const d = samsungDriver(conn, {
      socketFactory: tv.factory,
      fetchImpl: rest.fetchImpl,
      confirmMs: 1,
      confirmStepMs: 5,
    });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(said).toBe(
      'Samsung: he pedido abrir netflix, pero en pantalla sigue otra cosa; puede estar tardando o no haberse abierto.',
    );
    expect(rest.urls.length).toBeGreaterThanOrEqual(1);
  });

  it('la tele no contesta, da 404 o un JSON sin «visible» → la frase de siempre', async () => {
    for (const r of [
      new Error('ECONNREFUSED'),
      new Response('Not found', { status: 404 }),
      json({ id: 'x', name: 'Netflix' }),
      new Response('<html>', { status: 200 }),
    ]) {
      const tv = fakeSocket();
      const rest = fakeRest(() => r);
      const d = samsungDriver(conn, {
        socketFactory: tv.factory,
        fetchImpl: rest.fetchImpl,
        ...fast,
      });
      const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
      expect(said).toBe('Samsung: abriendo netflix.');
      expect(rest.urls).toHaveLength(1);
    }
  });

  it('sin confirmMs (tests, CLI) no se pregunta nada: como antes', async () => {
    const tv = fakeSocket();
    const rest = fakeRest(() => json({ visible: true }));
    const d = samsungDriver(conn, { socketFactory: tv.factory, fetchImpl: rest.fetchImpl });
    const said = await runIntentOnDriver(d, { action: 'launch', appId: 'netflix' });
    expect(said).toBe('Samsung: abriendo netflix.');
    expect(rest.urls).toHaveLength(0);
  });

  it('enlace de YouTube por DIAL: confirma la app de YouTube', async () => {
    const rest = fakeRest(() => json({ name: 'YouTube', visible: true }));
    const d = samsungDriver(conn, { fetchImpl: rest.fetchImpl, ...fast });
    const said = await runIntentOnDriver(d, {
      action: 'search',
      text: 'https://youtu.be/dQw4w9WgXcQ',
      appId: 'youtube',
    });
    expect(rest.urls).toEqual(['http://192.168.1.60:8001/api/v2/applications/111299001912']);
    expect(said).toBe('Samsung: YouTube abierto; comprobado, está en pantalla.');
  });

  it('enlace de Netflix por DIAL: confirma Netflix', async () => {
    const rest = fakeRest(() => json({ name: 'Netflix', visible: true }));
    const d = samsungDriver(conn, { fetchImpl: rest.fetchImpl, ...fast });
    const said = await runIntentOnDriver(d, {
      action: 'search',
      text: 'https://www.netflix.com/title/80057281',
      appId: 'netflix',
    });
    expect(rest.urls).toEqual(['http://192.168.1.60:8001/api/v2/applications/3201907018807']);
    expect(said).toBe('Samsung: Netflix abierto; comprobado, está en pantalla.');
  });

  it('samsungAppStatus: nombre recortado e id escapado en la URL', async () => {
    const rest = fakeRest(() => json({ name: `  ${'N'.repeat(200)} `, visible: false }));
    const st = await samsungAppStatus('192.168.1.60', 'org.tizen/../x', {
      fetchImpl: rest.fetchImpl,
    });
    expect(st).toEqual({ visible: false, name: 'N'.repeat(80) });
    expect(rest.urls[0]).toBe('http://192.168.1.60:8001/api/v2/applications/org.tizen%2F..%2Fx');
  });

  it('el daemon pasa el tope de confirmación a la Samsung', () => {
    const src = readFileSync(new URL('../src/plugins/tv.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/confirmMs: SAMSUNG_CONFIRM_MS/);
  });
});
