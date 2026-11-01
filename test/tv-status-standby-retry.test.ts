import { describe, expect, it } from 'vitest';
import { tvRequest } from '../src/tv/lgtv.js';
import { describeTvStatus, readTvStatus } from '../src/tv/status.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.237';
// Como el plugin en /tv estado: sin reintentos propios de conexion; los
// reintentos (y su presupuesto de tiempo) los pone readTvStatus.
const ssapFor =
  (tv: FakeWebOsTv, connectTimeoutMs = 1_500) =>
  (uri: string, payload: Record<string, unknown>) =>
    tvRequest(HOST, 'KEY123', uri, payload, {
      factory: tv.factory,
      connectRetries: 0,
      connectTimeoutMs,
    });

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('estado de la tele en reposo: reintenta antes de decir que esta apagada', () => {
  it('ANTES un primer rechazo bastaba para «apagada»; ahora al 3er intento contesta', async () => {
    const tv = new FakeWebOsTv({
      failOpens: 2,
      handlers: {
        'com.webos.service.tvpower/power/getPowerState': () => ({
          returnValue: true,
          state: 'Active Standby',
        }),
      },
    });
    const c = fakeClock();
    const st = await readTvStatus({ ssap: ssapFor(tv), sleep: c.sleep, clock: c.clock });
    expect(st).toMatchObject({ reachable: true, power: 'en reposo' });
    expect(c.sleeps).toEqual([250, 500]);
  });

  it('tambien reintenta cuando la apertura se queda colgada (timeout), no solo con rechazo', async () => {
    const tv = new FakeWebOsTv({
      failOpens: 1,
      openFailure: 'hang',
      handlers: {
        'com.webos.service.tvpower/power/getPowerState': () => ({
          returnValue: true,
          state: 'Active',
        }),
      },
    });
    const st = await readTvStatus({ ssap: ssapFor(tv, 30), sleep: async () => {} });
    expect(st).toMatchObject({ reachable: true, power: 'encendida' });
    expect(tv.urls.length).toBeGreaterThanOrEqual(2);
  });

  it('apagada de verdad: 3 intentos y no mas, mensaje claro en castellano', async () => {
    const tv = new FakeWebOsTv({ reachable: false });
    const c = fakeClock();
    const st = await readTvStatus({ ssap: ssapFor(tv), sleep: c.sleep, clock: c.clock });
    expect(st).toMatchObject({ reachable: false, power: 'apagada o fuera de red', attempts: 3 });
    expect(tv.urls).toHaveLength(3);
    const msg = describeTvStatus(st);
    expect(msg).toMatch(/lo he intentado 3 veces/);
    expect(msg).toMatch(/apagada del todo o fuera de la red/);
    expect(msg).toMatch(/enciende la tele/);
  });

  it('presupuesto ~6 s: si cada intento tarda mucho, no se pasa de 6 s esperando', async () => {
    const tv = new FakeWebOsTv({ reachable: false });
    const c = fakeClock();
    const ssap = ssapFor(tv);
    const slow = async (uri: string, payload: Record<string, unknown>) => {
      c.advance(2_800); // cada intento agota casi 3 s
      return ssap(uri, payload);
    };
    const st = await readTvStatus({ ssap: slow, sleep: c.sleep, clock: c.clock });
    expect(st.reachable).toBe(false);
    expect(c.clock()).toBeLessThanOrEqual(6_000);
    expect(tv.urls).toHaveLength(2);
  });

  it('un error SSAP (no de conexion) no se reintenta: la tele esta viva', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.service.tvpower/power/getPowerState': () => {
          throw new Error('no such service');
        },
        'com.webos.applicationManager/getForegroundAppInfo': () => ({
          returnValue: true,
          appId: 'netflix',
        }),
      },
    });
    const c = fakeClock();
    const st = await readTvStatus({ ssap: ssapFor(tv), sleep: c.sleep, clock: c.clock });
    expect(st).toMatchObject({ reachable: true, showing: 'Netflix' });
    expect(c.sleeps).toEqual([]);
  });
});
