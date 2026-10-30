import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool, explainTvError } from '../src/tools/tv.js';
import { GlasshouseAmbiguousError } from '../src/tv/glasshouse.js';
import { TvUnreachableError, tvRequest } from '../src/tv/lgtv.js';
import {
  describeTvStatus,
  inputFromAppId,
  parseVolume,
  readTvStatus,
  type TvStatus,
} from '../src/tv/status.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.237';
const ssapFor = (tv: FakeWebOsTv) => (uri: string, payload: Record<string, unknown>) =>
  tvRequest(HOST, 'KEY123', uri, payload, { factory: tv.factory, connectRetryDelayMs: 1 });

describe('estado en vivo de la tele', () => {
  it('encendida con Netflix delante y volumen (webOS 5+)', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.service.tvpower/power/getPowerState': () => ({
          returnValue: true,
          state: 'Active',
        }),
        'com.webos.applicationManager/getForegroundAppInfo': () => ({
          returnValue: true,
          appId: 'netflix',
        }),
        'audio/getVolume': () => ({
          returnValue: true,
          volumeStatus: { volume: 14, muteStatus: false },
        }),
      },
    });
    const st = await readTvStatus({
      ssap: ssapFor(tv),
      now: () => new Date('2026-10-30T20:00:00Z'),
    });
    expect(st).toMatchObject({
      reachable: true,
      power: 'encendida',
      appId: 'netflix',
      showing: 'Netflix',
      input: null,
      volume: 14,
      muted: false,
    });
    expect(describeTvStatus(st)).toBe('La tele esta encendida con Netflix delante. Volumen 14.');
    // Solo lecturas: nada que cambie la tele.
    expect(tv.requests.map((r) => r.uri).sort()).toEqual([
      'audio/getVolume',
      'com.webos.applicationManager/getForegroundAppInfo',
      'com.webos.service.tvpower/power/getPowerState',
    ]);
    expect(tv.allClosed()).toBe(true);
  });

  it('entrada HDMI y volumen antiguo silenciado', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.service.tvpower/power/getPowerState': () => ({
          returnValue: true,
          state: 'Active',
        }),
        'com.webos.applicationManager/getForegroundAppInfo': () => ({
          returnValue: true,
          appId: 'com.webos.app.hdmi2',
        }),
        'audio/getVolume': () => ({ returnValue: true, volume: 9, muted: true }),
      },
    });
    const st = await readTvStatus({ ssap: ssapFor(tv) });
    expect(st.input).toBe('HDMI 2');
    expect(describeTvStatus(st)).toBe(
      'La tele esta encendida con la entrada HDMI 2. Volumen 9 (silenciada).',
    );
  });

  it('app desconocida: se traduce con la lista de apps instaladas', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.applicationManager/getForegroundAppInfo': () => ({
          returnValue: true,
          appId: 'es.rtve.play',
        }),
      },
    });
    const st = await readTvStatus({
      ssap: ssapFor(tv),
      apps: async () => [{ id: 'es.rtve.play', title: 'RTVE Play' }],
    });
    expect(st.showing).toBe('RTVE Play');
    // getPowerState sin "state": responde, asi que esta viva; se dice lo que se sabe.
    expect(st.power).toBe('encendida');
  });

  it('pantalla apagada / reposo', async () => {
    for (const [state, word] of [
      ['Screen Off', 'pantalla apagada'],
      ['Active Standby', 'en reposo'],
    ] as const) {
      const tv = new FakeWebOsTv({
        handlers: {
          'com.webos.service.tvpower/power/getPowerState': () => ({ returnValue: true, state }),
        },
      });
      const st = await readTvStatus({ ssap: ssapFor(tv) });
      expect(st.power).toBe(word);
    }
  });

  it('tele inalcanzable: "apagada o fuera de red", un solo intento de lectura y sin inventar', async () => {
    const tv = new FakeWebOsTv({ reachable: false });
    const st = await readTvStatus({ ssap: ssapFor(tv) });
    expect(st).toMatchObject({ reachable: false, power: 'apagada o fuera de red', appId: null });
    expect(describeTvStatus(st)).toMatch(/apagada del todo o fuera de la red/);
    // Solo la lectura de energia (con su reintento de conexion): no sigue abriendo sockets.
    expect(tv.urls).toHaveLength(2);
  });

  it('una lectura que falla deja ese dato en null y el resto sigue', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.service.tvpower/power/getPowerState': () => ({
          returnValue: true,
          state: 'Active',
        }),
        'com.webos.applicationManager/getForegroundAppInfo': () => ({
          returnValue: true,
          appId: 'amazon',
        }),
        'audio/getVolume': () => {
          throw new Error('404 no such service');
        },
      },
    });
    const st = await readTvStatus({ ssap: ssapFor(tv) });
    expect(st).toMatchObject({ showing: 'Prime Video', volume: null, muted: null });
    expect(describeTvStatus(st)).toBe('La tele esta encendida con Prime Video delante.');
  });

  it('helpers: entrada y volumen fuera de rango', () => {
    expect(inputFromAppId('com.webos.app.hdmi4')).toBe('HDMI 4');
    expect(inputFromAppId('com.webos.app.livetv')).toBe('TV');
    expect(inputFromAppId('netflix')).toBeNull();
    expect(parseVolume({ volume: 300 })).toEqual({ volume: null, muted: null });
  });
});

const base = (over: Partial<TvToolDeps> = {}): TvToolDeps => ({
  shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
  foreground: async () => ({ appId: 'x', category: [] }),
  apps: async () => [],
  launch: async () => {},
  key: async () => {},
  toast: async () => {},
  power: async () => {},
  saveFrame: () => '',
  getState: () => null,
  setState: () => {},
  ...over,
});
type R = { content: Array<{ text?: string }>; details: Record<string, unknown> };
const run = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never) as unknown as Promise<R>;

describe('tool tv: status y errores en castellano', () => {
  it('action=status responde en una frase sin captura', async () => {
    const st: TvStatus = {
      reachable: true,
      power: 'encendida',
      powerState: 'Active',
      appId: 'youtube.leanback.v4',
      showing: 'YouTube',
      input: null,
      volume: 20,
      muted: false,
      checkedAt: '2026-10-30T20:00:00.000Z',
    };
    const calls: string[] = [];
    const r = await run(
      base({ status: async () => st, shot: async () => void calls.push('shot') as never }),
      { action: 'status' },
    );
    expect(r.content[0]?.text).toBe('La tele esta encendida con YouTube delante. Volumen 20.');
    expect(r.details.appId).toBe('youtube.leanback.v4');
    expect(calls).toEqual([]);
  });

  it('action=status sin soporte: error claro', async () => {
    await expect(run(base(), { action: 'status' })).rejects.toThrow(/no esta disponible/);
  });

  it('ANTES un fallo de red llegaba en jerga; ahora explica que significa, conserva el detalle y la clase', async () => {
    const original = new TvUnreachableError(
      'No se pudo conectar con la TV en 192.168.1.237 (wss://3001). ¿Encendida y en la misma red? (no abre)',
    );
    const err = await run(
      base({
        launch: async () => {
          throw original;
        },
      }),
      { action: 'launch', appId: 'netflix' },
    ).catch((e: unknown) => e);
    expect(err).toBe(original);
    expect(err).toBeInstanceOf(TvUnreachableError);
    expect((err as Error).message).toMatch(
      /^No llego a la tele: parece apagada del todo o fuera de la red\. Detalle: No se pudo conectar/,
    );
  });

  it('escritura ambigua: avisa de que no se repite', async () => {
    const err = await run(
      base({
        ghControl: async () => {
          throw new GlasshouseAmbiguousError('Glasshouse no contesto tras enviar volume.');
        },
      }),
      { action: 'volume', level: 10 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlasshouseAmbiguousError);
    expect((err as Error).message).toMatch(/puede que se haya aplicado\. No la repito/);
  });

  it('emparejamiento revocado y timeout: que hacer', () => {
    const revoked = explainTvError(
      new Error('La TV rechazo el registro: 401 insufficient permissions'),
    ) as Error;
    expect(revoked.message).toMatch(/volver a emparejar: pa tv setup <ip>/);
    const slow = explainTvError(new Error('La TV no respondio a audio/getVolume en 10s.')) as Error;
    expect(slow.message).toMatch(/tarda demasiado en contestar/);
  });

  it('los errores de validacion de la propia tool no cambian', async () => {
    await expect(run(base(), { action: 'power' })).rejects.toThrow(
      'action=power necesita on: true (encender pantalla) o false (apagar la tele).',
    );
  });

  it('no duplica la pista si el error ya la lleva', () => {
    const e = new TvUnreachableError(
      'No se pudo conectar con la TV en 192.168.1.237 (wss://3001).',
    );
    explainTvError(e);
    const once = e.message;
    explainTvError(e);
    expect(e.message).toBe(once);
  });
});
