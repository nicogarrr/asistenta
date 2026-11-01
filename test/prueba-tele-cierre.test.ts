import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { audioCommand } = await import('../src/audio/prueba-tele.js');
const { castAudioToTv } = await import('../src/audio/tv-cast.js');
type TvCastResult = import('../src/audio/tv-cast.js').TvCastResult;

function run(result: TvCastResult) {
  const lines: string[] = [];
  const code = audioCommand(['prueba-tele', 'nota.mp3'], {
    copyToTemp: async () => '/tmp/copia.mp3',
    cast: async () => result,
    print: (l) => lines.push(l),
    sleep: async () => {},
    fetchWaitMs: 1_000,
  });
  return { code, lines };
}

describe('pa audio prueba-tele: no se queda colgado', () => {
  it('la tele no lo bajó: cierra el servidor LAN al momento y sale con 1', async () => {
    const close = vi.fn();
    const { code, lines } = run({
      ok: true,
      message: 'm',
      via: 'media.viewer',
      hits: () => 0,
      close,
    });
    expect(await code).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toMatch(/firewall/i);
  });

  it('la tele lo bajó: NO cierra (sigue sonando) y dice cómo terminar', async () => {
    const close = vi.fn();
    const { code, lines } = run({
      ok: true,
      message: 'm',
      via: 'media.viewer',
      hits: () => 1,
      close,
    });
    expect(await code).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('Ctrl+C');
  });
});

describe('castAudioToTv: close() del resultado', () => {
  it('cierra el servidor de ESTA nota', async () => {
    const served = {
      url: 'http://192.168.1.10:5000/a/x.mp3',
      close: vi.fn(),
      closed: Promise.resolve(),
      hits: () => 0,
    };
    const r = await castAudioToTv('/tmp/nota.mp3', {
      tvHost: '192.168.1.20',
      ssap: async () => ({ returnValue: true }),
      pickAddress: () => '192.168.1.10',
      serve: async () => served,
    });
    expect(r.ok).toBe(true);
    expect(served.close).not.toHaveBeenCalled();
    r.close?.();
    expect(served.close).toHaveBeenCalledTimes(1);
  });
});
