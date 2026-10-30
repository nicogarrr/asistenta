import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { audioCommand, parsePruebaTele } from '../src/audio/prueba-tele.js';
import { castAudioToTv, TV_FIREWALL_HINT, type TvCastDeps } from '../src/audio/tv-cast.js';

function fakeServe(hits = { n: 0 }) {
  const close = vi.fn();
  const serve = (async () => ({
    url: 'http://192.168.1.10:5555/x.mp3',
    close,
    hits: () => hits.n,
  })) as unknown as TvCastDeps['serve'];
  return { serve, close, hits };
}

function tmpFile(): string {
  const f = join(mkdtempSync(join(tmpdir(), 'pt-')), 'a.mp3');
  writeFileSync(f, 'x');
  return f;
}

const fail = async () => {
  throw new Error('no existe');
};

describe('tele: tercera vía Glasshouse', () => {
  it('si fallan media.viewer y launcher, abre la URL con Glasshouse', async () => {
    const { serve } = fakeServe();
    const gh = vi.fn(async () => {});
    const r = await castAudioToTv(tmpFile(), {
      tvHost: '192.168.1.237',
      ssap: fail,
      serve,
      pickAddress: () => '192.168.1.10',
      glasshouse: gh,
    });
    expect(r).toMatchObject({ ok: true, via: 'glasshouse' });
    expect(gh).toHaveBeenCalledWith('http://192.168.1.10:5555/x.mp3');
    expect(r.tried).toEqual(['media.viewer: no existe', 'launcher: no existe']);
  });

  it('sin Glasshouse configurado, falla como antes y cierra el servidor', async () => {
    const { serve, close } = fakeServe();
    const r = await castAudioToTv(tmpFile(), {
      tvHost: '192.168.1.237',
      ssap: fail,
      serve,
      pickAddress: () => '192.168.1.10',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('media.viewer: no existe');
    expect(close).toHaveBeenCalled();
  });

  it('media.viewer sigue siendo la primera vía: Glasshouse no se toca', async () => {
    const { serve } = fakeServe();
    const gh = vi.fn(async () => {});
    const r = await castAudioToTv(tmpFile(), {
      tvHost: '192.168.1.237',
      ssap: async () => ({}),
      serve,
      pickAddress: () => '192.168.1.10',
      glasshouse: gh,
    });
    expect(r.via).toBe('media.viewer');
    expect(gh).not.toHaveBeenCalled();
  });

  it('only: prueba una sola vía', async () => {
    const { serve } = fakeServe();
    const ssap = vi.fn(async (_uri: string, _payload: Record<string, unknown>) => ({}));
    const r = await castAudioToTv(tmpFile(), {
      tvHost: '192.168.1.237',
      ssap,
      serve,
      pickAddress: () => '192.168.1.10',
      only: 'launcher',
    });
    expect(r.via).toBe('launcher');
    expect(ssap).toHaveBeenCalledTimes(1);
    expect(ssap.mock.calls[0]?.[0]).toBe('system.launcher/open');
  });
});

describe('pa audio prueba-tele', () => {
  const base = () => {
    const lines: string[] = [];
    return {
      lines,
      deps: {
        copyToTemp: async (f: string) => f,
        print: (l: string) => lines.push(l),
        sleep: async () => {},
        fetchWaitMs: 2000,
      },
    };
  };

  it('argumentos', () => {
    expect(parsePruebaTele(['a.mp3'])).toEqual({ file: 'a.mp3', only: undefined });
    expect(parsePruebaTele(['a.mp3', '--via', 'glasshouse'])).toEqual({
      file: 'a.mp3',
      only: 'glasshouse',
    });
    expect(parsePruebaTele(['--via', 'chromecast', 'a.mp3'])).toHaveProperty('error');
    expect(parsePruebaTele([])).toHaveProperty('error');
  });

  it('la tele acepta y descarga: código 0 y dice la vía', async () => {
    const { lines, deps } = base();
    let n = 0;
    const code = await audioCommand(['prueba-tele', 'a.mp3'], {
      ...deps,
      cast: async () => ({
        ok: true,
        via: 'launcher',
        message: '',
        tried: ['media.viewer: x'],
        hits: () => n++,
      }),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('✗ media.viewer: x');
    expect(lines.join('\n')).toContain('por launcher');
    expect(lines.join('\n')).toContain('ha descargado');
  });

  it('acepta pero nunca descarga: pista del firewall de Windows', async () => {
    const { lines, deps } = base();
    const code = await audioCommand(['prueba-tele', 'a.mp3'], {
      ...deps,
      cast: async () => ({ ok: true, via: 'media.viewer', message: '', hits: () => 0 }),
    });
    expect(code).toBe(1);
    expect(lines.at(-1)).toContain(TV_FIREWALL_HINT);
    expect(TV_FIREWALL_HINT).toMatch(/firewall de Windows/);
    expect(TV_FIREWALL_HINT).toMatch(/Node/);
  });

  it('ninguna vía: código 1; uso incorrecto: código 2 sin tocar la tele', async () => {
    const { deps } = base();
    const cast = vi.fn(async () => ({ ok: false, message: 'La tele no ha aceptado el audio' }));
    expect(await audioCommand(['prueba-tele', 'a.mp3'], { ...deps, cast })).toBe(1);
    expect(await audioCommand(['otra'], { ...deps, cast })).toBe(2);
    expect(await audioCommand(['prueba-tele'], { ...deps, cast })).toBe(2);
    expect(cast).toHaveBeenCalledTimes(1);
  });

  it('pasa --via al envío', async () => {
    const { deps } = base();
    const cast = vi.fn(async () => ({ ok: false, message: 'no' }));
    await audioCommand(['prueba-tele', 'a.mp3', '--via', 'glasshouse'], { ...deps, cast });
    expect(cast).toHaveBeenCalledWith('a.mp3', 'glasshouse');
  });
});
