/**
 * Samsung apagada del todo: «abre Netflix» o «pon en YouTube <enlace>» la
 * encienden por red y hacen la orden en una sola vez, como la LG desde #1936
 * (asis-computeruse-4, pista 3 de cu3/HANDOFF.md). Con fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { runIntentWaking } from '../src/tv/drivers.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { type SamsungSocket, SamsungUnreachableError, samsungDriver } from '../src/tv/samsung.js';

const conn = { host: '192.168.1.61', secure: false, token: 'tok' };

/** Tele fake: «apagada» hasta que llega el WoL y pasan `bootTries` intentos. */
function fakeTv(bootTries = 1) {
  let awake = false;
  let triesAfterWake = 0;
  const sent: string[] = [];
  const wake = vi.fn(async () => {
    awake = true;
  });
  const factory = (): SamsungSocket => {
    const handlers: Record<string, Array<(x?: unknown) => void>> = {};
    const up = awake && ++triesAfterWake > bootTries - 1;
    setTimeout(() => {
      if (!up) for (const h of handlers.error ?? []) h(new Error('connect EHOSTUNREACH'));
      else
        for (const h of handlers.message ?? [])
          h(JSON.stringify({ event: 'ms.channel.connect', data: { token: 'tok' } }));
    }, 1);
    return {
      on: (ev: string, fn: (x?: unknown) => void) => {
        if (!handlers[ev]) handlers[ev] = [];
        handlers[ev].push(fn);
      },
      send: (s: string) => sent.push(s),
      close: () => {},
    } as unknown as SamsungSocket;
  };
  const launched = () =>
    sent
      .map((s) => JSON.parse(s) as { params?: { event?: string; data?: { appId?: string } } })
      .filter((m) => m.params?.event === 'ed.apps.launch')
      .map((m) => m.params?.data?.appId);
  return { factory, wake, launched };
}
const fast = { sleep: async () => {}, retryMs: 0 };
const intentOf = (text: string) => {
  const i = parseTvCommand(text);
  if (!i) throw new Error(text);
  return i;
};

describe('Samsung apagada: WoL y la orden en una sola vez', () => {
  it('«abre Netflix»: antes «No llego a la Samsung»; ahora WoL + abre Netflix', async () => {
    const tv = fakeTv(2);
    const d = samsungDriver(conn, {
      socketFactory: tv.factory,
      graceMs: 0,
      mac: 'aa:bb:cc:dd:ee:ff',
      wake: tv.wake,
    });
    const said = await runIntentWaking(d, intentOf('abre Netflix en la tele'), fast);
    expect(tv.wake).toHaveBeenCalledTimes(1);
    expect(tv.wake).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', '192.168.1.61');
    expect(tv.launched()).toEqual(['3201907018807']);
    expect(said).toMatch(/apagada del todo: la he encendido por red/);
  });

  it('una orden que llegó no se repite, y sin MAC sale el error de siempre', async () => {
    const tv = fakeTv();
    const noMac = samsungDriver(conn, { socketFactory: tv.factory, graceMs: 0, wake: tv.wake });
    await expect(runIntentWaking(noMac, intentOf('abre Netflix en la tele'), fast)).rejects.toThrow(
      /No llego a la Samsung/,
    );
    expect(tv.wake).not.toHaveBeenCalled();
  });

  it('subir el volumen o apagar no encienden nada (solo «poner algo»)', async () => {
    const tv = fakeTv();
    const d = samsungDriver(conn, {
      socketFactory: tv.factory,
      graceMs: 0,
      mac: 'aa:bb:cc:dd:ee:ff',
      wake: tv.wake,
    });
    await expect(runIntentWaking(d, intentOf('sube el volumen de la tele'), fast)).rejects.toThrow(
      SamsungUnreachableError,
    );
    expect(tv.wake).not.toHaveBeenCalled();
  });

  it('si tras el WoL no contesta en el tope, lo dice claro (sin bucle infinito)', async () => {
    const tv = fakeTv(99);
    const d = samsungDriver(conn, {
      socketFactory: tv.factory,
      graceMs: 0,
      mac: 'aa:bb:cc:dd:ee:ff',
      wake: tv.wake,
    });
    let t = 0;
    await expect(
      runIntentWaking(d, intentOf('abre Netflix en la tele'), {
        sleep: async () => {
          t += 2000;
        },
        now: () => t,
        bootMs: 10_000,
      }),
    ).rejects.toThrow(/no contesta tras 10 s/);
    expect(tv.launched()).toEqual([]);
  });

  it('apagada y app sin id conocido: no dice «No sé abrir», enciende y la busca en su lista', async () => {
    const tv = fakeTv(1);
    const listApps = vi
      .fn()
      .mockRejectedValueOnce(new SamsungUnreachableError('No llego a la Samsung'))
      .mockResolvedValue([{ id: '593099', title: 'RTVE Play' }]);
    const d = samsungDriver(conn, {
      socketFactory: tv.factory,
      graceMs: 0,
      mac: 'aa:bb:cc:dd:ee:ff',
      wake: tv.wake,
      installedApps: listApps,
    });
    const said = await runIntentWaking(d, intentOf('abre RTVE Play en la tele'), fast);
    expect(tv.launched()).toEqual(['593099']);
    expect(said).toMatch(/encendido por red/);
  });

  it('DIAL sin respuesta también cuenta como apagada: WoL y la búsqueda', async () => {
    let up = false;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (!up) throw new TypeError('fetch failed');
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    const wake = vi.fn(async () => {
      up = true;
    });
    const d = samsungDriver(conn, { fetchImpl, mac: 'aa:bb:cc:dd:ee:ff', wake });
    const said = await runIntentWaking(d, intentOf('busca Dune en Netflix en la tele'), fast);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(said).toMatch(/buscando «dune»/);
  });
});
