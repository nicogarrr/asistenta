import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import { castAudioToTv, type TvCastDeps } from '../src/audio/tv-cast.js';

/**
 * /stop con /altavoz tele cuando la nota se abrió con el navegador de la tele
 * (system.launcher) o con Glasshouse: media.controls/stop no para una URL abierta así.
 * Se cierra la app que abrió NUESTRO cast, solo si sigue en primer plano, y nunca el
 * inicio ni la TV en directo. Tele falsa: un ssap que registra las órdenes.
 */
const FG = 'com.webos.applicationManager/getForegroundAppInfo';

function fakeServe() {
  return (async () => ({
    url: 'http://192.168.1.10:5555/x.mp3',
    close: vi.fn(),
    hits: () => 1,
  })) as unknown as TvCastDeps['serve'];
}

function tmpFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'stl-')), 'a.mp3');
  writeFileSync(f, 'x');
  return f;
}

/** Tele falsa: `fg` es la app en primer plano; registra cada orden. */
function fakeTv(opts: { viewer?: boolean; launcher?: boolean; fg: string[] }) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let fgIdx = 0;
  const ssap = vi.fn(async (uri: string, payload: Record<string, unknown>) => {
    calls.push([uri, payload]);
    if (uri === 'media.viewer/open') {
      if (!opts.viewer) throw new Error('no existe');
      return { returnValue: true };
    }
    if (uri === 'system.launcher/open') {
      if (!opts.launcher) throw new Error('no existe');
      return { returnValue: true, id: 'com.webos.app.browser', sessionId: 's1' };
    }
    if (uri === FG) {
      const appId = opts.fg[Math.min(fgIdx, opts.fg.length - 1)];
      fgIdx++;
      return { returnValue: true, appId };
    }
    if (uri === 'media.controls/stop') throw new Error('nada que parar');
    return { returnValue: true };
  });
  return { ssap, calls, uris: () => calls.map(([u]) => u) };
}

const base = { tvHost: '192.168.1.237', pickAddress: () => '192.168.1.10' };

describe('tele: parar una nota abierta con el navegador o Glasshouse', () => {
  it('launcher: cierra el navegador que abrió el cast si sigue delante', async () => {
    const tv = fakeTv({ launcher: true, fg: ['com.webos.app.browser'] });
    const r = await castAudioToTv(tmpFile(), { ...base, ssap: tv.ssap, serve: fakeServe() });
    expect(r.via).toBe('launcher');
    await r.stop?.();
    expect(tv.calls).toContainEqual(['system.launcher/close', { id: 'com.webos.app.browser' }]);
  });

  it('launcher: si Nico ya cambió de app, no cierra nada', async () => {
    const tv = fakeTv({ launcher: true, fg: ['netflix'] });
    const r = await castAudioToTv(tmpFile(), { ...base, ssap: tv.ssap, serve: fakeServe() });
    await r.stop?.();
    expect(r.stop).toBeTypeOf('function');
    expect(tv.uris()).not.toContain('system.launcher/close');
  });

  it('glasshouse: cierra la app que apareció con el cast', async () => {
    const tv = fakeTv({ fg: ['com.webos.app.livetv', 'com.webos.app.browser'] });
    const r = await castAudioToTv(tmpFile(), {
      ...base,
      ssap: tv.ssap,
      serve: fakeServe(),
      glasshouse: async () => {},
    });
    expect(r.via).toBe('glasshouse');
    await r.stop?.();
    expect(tv.calls).toContainEqual(['system.launcher/close', { id: 'com.webos.app.browser' }]);
  });

  it('glasshouse: nunca cierra el inicio ni la TV en directo', async () => {
    const tv = fakeTv({ fg: ['netflix', 'com.webos.app.home'] });
    const r = await castAudioToTv(tmpFile(), {
      ...base,
      ssap: tv.ssap,
      serve: fakeServe(),
      glasshouse: async () => {},
    });
    await r.stop?.();
    expect(r.stop).toBeTypeOf('function');
    expect(tv.uris()).not.toContain('system.launcher/close');
  });

  it('glasshouse: sin saber qué había antes, no cierra nada', async () => {
    const tv = fakeTv({ fg: [] });
    tv.ssap.mockImplementation(async (uri: string) => {
      if (uri === FG) throw new Error('sin permiso');
      if (uri.endsWith('/open')) throw new Error('no existe');
      return { returnValue: true };
    });
    const r = await castAudioToTv(tmpFile(), {
      ...base,
      ssap: tv.ssap,
      serve: fakeServe(),
      glasshouse: async () => {},
    });
    await r.stop?.();
    expect(r.stop).toBeTypeOf('function');
    expect(tv.ssap.mock.calls.map(([u]) => u)).not.toContain('system.launcher/close');
  });

  it('media.viewer: sigue parando con media.controls/stop y no cierra apps', async () => {
    const tv = fakeTv({ viewer: true, fg: ['com.webos.app.mediaviewer'] });
    tv.ssap.mockImplementation(async (uri: string, payload: Record<string, unknown>) => {
      tv.calls.push([uri, payload]);
      return { returnValue: true };
    });
    const r = await castAudioToTv(tmpFile(), { ...base, ssap: tv.ssap, serve: fakeServe() });
    await r.stop?.();
    expect(tv.uris()).toContain('media.controls/stop');
    expect(tv.uris()).not.toContain('system.launcher/close');
  });
});

describe('/stop usa el «parar» del propio cast', () => {
  it('con la nota abierta por el navegador, /stop llama a su stop y no al genérico', async () => {
    const castStop = vi.fn(async () => {});
    const stopTv = vi.fn(async () => true);
    const p = createAltavozPlayer({
      toPlayable: async () => '/tmp/fake.mp3',
      playOnPc: async () => {},
      castToTv: async () => ({ ok: true, message: 'ok', hits: () => 1, stop: castStop }),
      stopTv,
      remove: () => {},
      now: () => 1_000_000,
    });
    p.enqueue(
      'tele',
      async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' }),
      undefined,
      'chat:A',
    );
    await p.idle();
    expect(p.clear('chat:A')).toBe(1);
    expect(castStop).toHaveBeenCalledTimes(1);
    expect(stopTv).not.toHaveBeenCalled();
  });
});
