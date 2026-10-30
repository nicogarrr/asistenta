// Encendido por red (lane tv7): la espera tras el Wake-on-LAN cuenta tiempo real.
import { describe, expect, it } from 'vitest';
import { TvUnreachableError } from '../src/tv/lgtv.js';
import { tvPower } from '../src/tv/power.js';

/**
 * Tras el Wake-on-LAN se sondea la tele hasta `wakeWaitMs` (20 s). Antes el
 * presupuesto solo contaba los `sleep`: cada sondeo a una tele que aun no
 * contesta tarda el timeout de conexion (~5 s + orden), asi que «enciende la
 * tele» podia quedarse colgado mas de un minuto antes de decir que no.
 */
describe('encendido por red: la espera tras el WoL respeta el tiempo real', () => {
  const deps = (clock: { t: number }, probeCostMs: number, onProbe: () => boolean) => ({
    ssap: async () => {
      throw new TvUnreachableError('no conecta');
    },
    wake: async () => undefined,
    probe: async () => {
      clock.t += probeCostMs;
      return onProbe();
    },
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    now: () => clock.t,
    pollMs: 2_000,
    wakeWaitMs: 20_000,
  });

  it('sondeos lentos: se rinde al agotar 20 s reales, no tras 10 sondeos', async () => {
    const clock = { t: 0 };
    let probes = 0;
    const out = await tvPower(
      true,
      deps(clock, 5_000, () => {
        probes += 1;
        return false;
      }),
    );
    expect(out).toEqual({ via: 'wol', verified: false });
    expect(probes).toBeLessThanOrEqual(3);
    expect(clock.t).toBeLessThanOrEqual(20_000 + 7_000);
  });

  it('si la tele contesta dentro del plazo, se confirma igual que antes', async () => {
    const clock = { t: 0 };
    let probes = 0;
    const out = await tvPower(
      true,
      deps(clock, 5_000, () => {
        probes += 1;
        return probes === 2;
      }),
    );
    expect(out).toEqual({ via: 'wol', verified: true });
    expect(probes).toBe(2);
  });

  it('sondeos instantaneos: mismos 10 intentos de siempre', async () => {
    const clock = { t: 0 };
    let probes = 0;
    const out = await tvPower(
      true,
      deps(clock, 0, () => {
        probes += 1;
        return false;
      }),
    );
    expect(out.verified).toBe(false);
    expect(probes).toBe(10);
  });
});
