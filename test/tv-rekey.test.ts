// Re-emparejado: cliente SSAP contra la tele falsa (PROMPT con clave vieja).
import { describe, expect, it, vi } from 'vitest';
import { tvRequest } from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

/**
 * La tele olvida la client-key guardada (reinicio de fabrica, app borrada…):
 * con una clave desconocida la tele real responde PROMPT y muestra el aviso de
 * emparejamiento. Antes el cliente ignoraba ese PROMPT (agotaba el timeout de
 * la orden con «no respondio al registro») y, si Nico aceptaba el aviso,
 * TIRABA la clave nueva: cada orden siguiente volvia a sacar el aviso.
 */
describe('tele que ha olvidado el emparejamiento (re-emparejado)', () => {
  it('aviso aceptado: la orden sale y la clave NUEVA se entrega para guardarla', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'NUEVA', unknownKey: 'prompt-accept' });
    const saved: string[] = [];
    const res = await tvRequest(
      '192.168.1.50',
      'VIEJA',
      'audio/getVolume',
      {},
      {
        factory: tv.factory,
        onNewClientKey: (k) => {
          saved.push(k);
        },
      },
    );
    expect(res.returnValue).toBe(true);
    expect(saved).toEqual(['NUEVA']);
    expect(tv.requests.map((r) => r.uri)).toEqual(['audio/getVolume']);
    expect(tv.allClosed()).toBe(true);
  });

  it('con la clave de siempre no se avisa de clave nueva', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'KEY123' });
    const onNewClientKey = vi.fn();
    await tvRequest(
      '192.168.1.50',
      'KEY123',
      'audio/getVolume',
      {},
      {
        factory: tv.factory,
        onNewClientKey,
      },
    );
    expect(onNewClientKey).not.toHaveBeenCalled();
  });

  it('si guardar la clave nueva falla, la orden igualmente sale', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'NUEVA', unknownKey: 'prompt-accept' });
    const res = await tvRequest(
      '192.168.1.50',
      'VIEJA',
      'audio/getVolume',
      {},
      {
        factory: tv.factory,
        onNewClientKey: () => {
          throw new Error('vault roto');
        },
      },
    );
    expect(res.returnValue).toBe(true);
    expect(tv.requests).toHaveLength(1);
  });

  it('aviso sin aceptar: error claro que explica que hacer, sin orden enviada', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'NUEVA', unknownKey: 'prompt' });
    const err = await tvRequest(
      '192.168.1.50',
      'VIEJA',
      'system/turnOff',
      {},
      {
        factory: tv.factory,
        commandTimeoutMs: 40,
        promptWaitMs: 40,
      },
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ya no reconoce el emparejamiento/);
    expect((err as Error).message).toMatch(/pa tv setup/);
    expect((err as Error).message).not.toContain('VIEJA');
    expect(tv.requests).toHaveLength(0);
    expect(tv.allClosed()).toBe(true);
  });

  it('tras el aviso se espera a Nico (promptWaitMs), no solo el timeout corto de la orden', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'NUEVA', unknownKey: 'prompt' });
    const t0 = Date.now();
    await tvRequest(
      '192.168.1.50',
      'VIEJA',
      'audio/getVolume',
      {},
      {
        factory: tv.factory,
        commandTimeoutMs: 30,
        promptWaitMs: 250,
      },
    ).catch(() => undefined);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it('sin aviso (tele que contesta 401) el error de siempre no cambia', async () => {
    const tv = new FakeWebOsTv({ clientKey: 'NUEVA' });
    const onNewClientKey = vi.fn();
    await expect(
      tvRequest(
        '192.168.1.50',
        'VIEJA',
        'audio/getVolume',
        {},
        {
          factory: tv.factory,
          onNewClientKey,
        },
      ),
    ).rejects.toThrow(/rechazo el registro/);
    expect(onNewClientKey).not.toHaveBeenCalled();
  });
});
