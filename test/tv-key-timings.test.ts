/**
 * tvKey: esperas configurables (timeout total y margen de consumo tras enviar)
 * y socket de input inyectable, probado contra la tele falsa. Por defecto el
 * comportamiento no cambia: 5 s y 800 ms, comprobados en la tele real.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TV_KEY_GRACE_MS, TV_KEY_TIMEOUT_MS, tvKey, tvKeyTimings } from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.50';
const saved = { t: process.env.PA_TV_KEY_TIMEOUT_MS, g: process.env.PA_TV_KEY_GRACE_MS };

beforeEach(() => {
  delete process.env.PA_TV_KEY_TIMEOUT_MS;
  delete process.env.PA_TV_KEY_GRACE_MS;
});
afterEach(() => {
  if (saved.t === undefined) delete process.env.PA_TV_KEY_TIMEOUT_MS;
  else process.env.PA_TV_KEY_TIMEOUT_MS = saved.t;
  if (saved.g === undefined) delete process.env.PA_TV_KEY_GRACE_MS;
  else process.env.PA_TV_KEY_GRACE_MS = saved.g;
});

function deps(tv: FakeWebOsTv, extra: Record<string, unknown> = {}) {
  return { factory: tv.factory, inputFactory: tv.inputFactory, ...extra };
}

describe('tvKeyTimings', () => {
  it('por defecto 5000 ms / 800 ms (sin cambios respecto a la tele real)', () => {
    expect(TV_KEY_TIMEOUT_MS).toBe(5000);
    expect(TV_KEY_GRACE_MS).toBe(800);
    expect(tvKeyTimings()).toEqual({ timeoutMs: 5000, graceMs: 800 });
  });

  it('lee PA_TV_KEY_TIMEOUT_MS y PA_TV_KEY_GRACE_MS', () => {
    process.env.PA_TV_KEY_TIMEOUT_MS = '8000';
    process.env.PA_TV_KEY_GRACE_MS = '1200';
    expect(tvKeyTimings()).toEqual({ timeoutMs: 8000, graceMs: 1200 });
  });

  it('las deps mandan sobre el entorno', () => {
    process.env.PA_TV_KEY_TIMEOUT_MS = '8000';
    expect(tvKeyTimings({ keyTimeoutMs: 2000, keyGraceMs: 300 })).toEqual({
      timeoutMs: 2000,
      graceMs: 300,
    });
  });

  it('acota valores absurdos y ignora basura', () => {
    process.env.PA_TV_KEY_TIMEOUT_MS = '999999';
    process.env.PA_TV_KEY_GRACE_MS = '0';
    expect(tvKeyTimings()).toEqual({ timeoutMs: 30000, graceMs: 50 });
    process.env.PA_TV_KEY_TIMEOUT_MS = 'abc';
    process.env.PA_TV_KEY_GRACE_MS = '';
    expect(tvKeyTimings()).toEqual({ timeoutMs: 5000, graceMs: 800 });
    expect(tvKeyTimings({ keyTimeoutMs: Number.NaN, keyGraceMs: -5 })).toEqual({
      timeoutMs: 5000,
      graceMs: 50,
    });
  });
});

describe('tvKey contra la tele falsa', () => {
  it('envía la tecla por el socket de input de la propia tele y cierra', async () => {
    const tv = new FakeWebOsTv();
    await tvKey(HOST, 'KEY123', 'home', deps(tv, { keyGraceMs: 50 }));
    expect(tv.buttons).toEqual(['HOME']);
    expect(tv.inputUrls).toEqual([`wss://${HOST}:3001/resources/input`]);
    expect(tv.requests.map((r) => r.uri)).toContain(
      'com.webos.service.networkinput/getPointerInputSocket',
    );
    expect(tv.allClosed()).toBe(true);
  });

  it('respeta el margen configurado: no confirma antes de tiempo', async () => {
    const tv = new FakeWebOsTv();
    let done = false;
    const p = tvKey(HOST, 'KEY123', 'OK', deps(tv, { keyGraceMs: 600 })).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(tv.buttons).toEqual(['OK']);
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });

  it('timeout configurable si el socket de input nunca abre', async () => {
    const tv = new FakeWebOsTv({ inputMode: 'hang' });
    const t0 = Date.now();
    await expect(tvKey(HOST, 'KEY123', 'HOME', deps(tv, { keyTimeoutMs: 1000 }))).rejects.toThrow(
      'timeout enviando la tecla',
    );
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(4000);
    expect(tv.buttons).toEqual([]);
    expect(tv.allClosed()).toBe(true);
  });

  it('no confirma si la tele cierra el socket antes del margen', async () => {
    const tv = new FakeWebOsTv({ inputMode: 'close-early' });
    await expect(tvKey(HOST, 'KEY123', 'HOME', deps(tv))).rejects.toThrow(
      'cerro el socket de input antes de tiempo',
    );
  });

  it('error al abrir el socket de input = fallo, sin tecla', async () => {
    const tv = new FakeWebOsTv({ inputMode: 'error' });
    await expect(tvKey(HOST, 'KEY123', 'HOME', deps(tv))).rejects.toThrow(
      'no se pudo enviar la tecla',
    );
    expect(tv.buttons).toEqual([]);
  });

  it('una tecla fuera de la lista no abre ningún socket', async () => {
    const tv = new FakeWebOsTv();
    await expect(tvKey(HOST, 'KEY123', 'HOME\nname:POWER', deps(tv))).rejects.toThrow(
      'Tecla no valida',
    );
    expect(tv.urls).toEqual([]);
    expect(tv.inputUrls).toEqual([]);
  });
});
