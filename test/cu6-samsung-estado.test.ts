/**
 * Samsung: «¿qué está viendo la tele?» contestaba «La Samsung no deja leer qué
 * está viendo desde Asistenta». Su API local (REST :8001) dice si está en
 * reposo (`PowerState`) y si cada app está en pantalla (`visible`): ahora lo
 * contesta con las apps conocidas, solo con consultas (asis-computeruse-6). Con fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { samsungDriver, samsungStatus } from '../src/tv/samsung.js';

const host = '192.168.1.90';
type R = object | number | Error;
function fakeRest(info: R, apps: Record<string, R> = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}`);
    const id = /\/applications\/([^/]+)$/.exec(u.pathname)?.[1];
    const r = id ? (apps[decodeURIComponent(id)] ?? { id, visible: false, running: false }) : info;
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('', { status: r });
    return new Response(JSON.stringify(r), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const ON = { device: { PowerState: 'on', name: 'Salón' } };

describe('Samsung: qué hay en pantalla', () => {
  it('la orden de estado llega a la Samsung y dice la app visible (sin tocar la tele)', async () => {
    const rest = fakeRest(ON, {
      '111299001912': { name: 'YouTube', visible: true, running: true },
    });
    const said = await runIntentOnDriver(
      samsungDriver({ host, secure: false }, { fetchImpl: rest.fetchImpl }),
      { action: 'status' },
    );
    expect(said).toBe('Samsung: en pantalla está YouTube.');
    expect(rest.calls.every((c) => c.startsWith('GET /api/v2/'))).toBe(true);
  });

  it('la tele no da el nombre → el de la lista conocida', async () => {
    const rest = fakeRest(ON, { '3201907018807': { visible: true } });
    expect(await samsungStatus(host, { fetchImpl: rest.fetchImpl })).toBe(
      'Samsung: en pantalla está Netflix.',
    );
  });

  it('en reposo lo dice sin preguntar por las apps', async () => {
    const rest = fakeRest({ device: { PowerState: 'standby' } });
    expect(await samsungStatus(host, { fetchImpl: rest.fetchImpl })).toBe(
      'Samsung: está en reposo (pantalla apagada).',
    );
    expect(rest.calls).toEqual(['GET /api/v2/']);
  });

  it('ninguna app conocida visible → lo dice sin inventar', async () => {
    const rest = fakeRest(ON);
    expect(await samsungStatus(host, { fetchImpl: rest.fetchImpl })).toBe(
      'Samsung: está encendida; en pantalla no está Netflix, YouTube, Prime Video, Disney+, Spotify ni Apple TV (será la tele, un HDMI u otra app).',
    );
    expect(rest.calls.filter((c) => c.includes('/applications/'))).toHaveLength(6);
  });

  it('las apps no contestan (404 o error) → no afirma nada sobre la pantalla', async () => {
    const all404 = Object.fromEntries(
      [
        '3201907018807',
        '111299001912',
        '3201910019365',
        '3201901017640',
        '3201606009684',
        '3201807016597',
      ].map((id) => [id, 404]),
    );
    const rest = fakeRest({ device: {} }, all404);
    expect(await samsungStatus(host, { fetchImpl: rest.fetchImpl })).toBe(
      'Samsung: está encendida, pero no dice qué tiene en pantalla.',
    );
  });

  it('apagada del todo (no contesta) → lo dice, sin encenderla', async () => {
    const wake = vi.fn(async () => {});
    const rest = fakeRest(new Error('ETIMEDOUT'));
    const said = await runIntentOnDriver(
      samsungDriver(
        { host, secure: false },
        { fetchImpl: rest.fetchImpl, mac: 'aa:bb:cc:dd:ee:ff', wake },
      ),
      { action: 'status' },
    );
    expect(said).toBe(
      'Samsung: no contesta por la red; parece apagada del todo (o fuera de la wifi).',
    );
    expect(wake).not.toHaveBeenCalled();
    expect(rest.calls).toEqual(['GET /api/v2/']);
  });
});
