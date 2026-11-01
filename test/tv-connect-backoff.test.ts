// Reconexion tras encender: la tele recien encendida puede rechazar mas de un
// intento de apertura. Antes: un solo reintento a los 600 ms. Ahora: 2
// reintentos con espera creciente (500 ms, 1 s). Solo tele falsa.
import { describe, expect, it } from 'vitest';
import { tvRequest } from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.237';

describe('apertura con backoff corto tras encender la tele', () => {
  it('dos rechazos seguidos: el tercer intento entra y la orden se envia una vez', async () => {
    const tv = new FakeWebOsTv({ failOpens: 2 });
    const res = await tvRequest(
      HOST,
      'KEY123',
      'audio/volumeUp',
      {},
      {
        factory: tv.factory,
        connectRetryDelayMs: 1,
      },
    );
    expect(res.returnValue).toBe(true);
    expect(tv.urls).toHaveLength(3);
    expect(tv.requests.filter((r) => r.uri.endsWith('audio/volumeUp'))).toHaveLength(1);
  });

  it('tres rechazos: se rinde tras 3 intentos sin enviar nada', async () => {
    const tv = new FakeWebOsTv({ failOpens: 3 });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'audio/volumeUp',
        {},
        {
          factory: tv.factory,
          connectRetryDelayMs: 1,
        },
      ),
    ).rejects.toThrow(/No se pudo conectar con la TV/);
    expect(tv.urls).toHaveLength(3);
    expect(tv.requests).toEqual([]);
  });

  it('la espera crece entre reintentos (base, luego el doble)', async () => {
    const tv = new FakeWebOsTv({ failOpens: 2 });
    const t0 = Date.now();
    await tvRequest(
      HOST,
      'KEY123',
      'audio/volumeUp',
      {},
      {
        factory: tv.factory,
        connectRetryDelayMs: 40,
      },
    );
    // 40 ms + 80 ms como minimo (antes: un solo reintento y fallo).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(115);
    expect(tv.urls).toHaveLength(3);
  });

  it('connectRetries: 0 sigue sin reintentar (sondeo de encendido)', async () => {
    const tv = new FakeWebOsTv({ failOpens: 1 });
    await expect(
      tvRequest(
        HOST,
        'KEY123',
        'audio/volumeUp',
        {},
        {
          factory: tv.factory,
          connectRetries: 0,
        },
      ),
    ).rejects.toThrow(/No se pudo conectar con la TV/);
    expect(tv.urls).toHaveLength(1);
  });
});
