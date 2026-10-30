import { afterEach, describe, expect, it } from 'vitest';
import { tvCommandTimeoutMs, tvRequest, tvToast } from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.237';
const ENV = 'PA_TV_CMD_TIMEOUT_MS';

afterEach(() => {
  delete process.env[ENV];
});

describe('PA_TV_CMD_TIMEOUT_MS', () => {
  it('sin variable: 10 s como siempre', () => {
    delete process.env[ENV];
    expect(tvCommandTimeoutMs()).toBe(10_000);
  });

  it.each([
    ['15000', 15_000],
    ['500', 2_000],
    ['999999', 60_000],
    ['abc', 10_000],
    ['  ', 10_000],
  ])('%s → %i ms', (raw, ms) => {
    process.env[ENV] = raw;
    expect(tvCommandTimeoutMs()).toBe(ms);
  });

  it('la variable manda en tvRequest cuando no se pasa commandTimeoutMs', async () => {
    process.env[ENV] = '2000';
    const tv = new FakeWebOsTv({ handlers: { 'system/turnOff': () => 'silent' } });
    const t0 = Date.now();
    await expect(
      tvRequest(HOST, 'KEY123', 'system/turnOff', {}, { factory: tv.factory }),
    ).rejects.toThrow('La TV no respondio a system/turnOff en 2s.');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(tv.allClosed()).toBe(true);
  });

  it('deps.commandTimeoutMs manda sobre la variable', async () => {
    process.env[ENV] = '60000';
    const tv = new FakeWebOsTv({ handlers: { 'system/turnOff': () => 'silent' } });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'system/turnOff',
        {},
        { factory: tv.factory, commandTimeoutMs: 50 },
      ),
    ).rejects.toThrow('en 0.05s');
  });
});

describe('tvToast: tele muda', () => {
  it('createToast sin respuesta → error con su uri y la conexión cerrada', async () => {
    const tv = new FakeWebOsTv({
      handlers: { 'system.notifications/createToast': () => 'silent' },
    });
    await expect(
      tvToast(HOST, 'KEY123', 'Hola', { factory: tv.factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow('La TV no respondio a system.notifications/createToast');
    expect(tv.allClosed()).toBe(true);
  });
});
