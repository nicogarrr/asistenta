import { describe, expect, it } from 'vitest';
import { createTvTool, MAX_HALF_KEY_PRESSES, type TvToolDeps } from '../src/tools/tv.js';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';
import type { TvStatus } from '../src/tv/status.js';

function status(volume: number | null): TvStatus {
  return { power: 'encendida', volume, muted: false } as unknown as TvStatus;
}

function deps(over: Partial<TvToolDeps> = {}): { deps: TvToolDeps; calls: string[] } {
  const calls: string[] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [],
    launch: async (id) => void calls.push(`launch:${id}`),
    key: async (n) => void calls.push(`key:${n}`),
    toast: async (m) => void calls.push(`toast:${m}`),
    power: async (on) => void calls.push(`power:${on}`),
    saveFrame: () => '/tmp/x.jpg',
    getState: () => null,
    setState: () => {},
    ...over,
  };
  return { deps: d, calls };
}

async function run(d: TvToolDeps, text: string) {
  const tool = createTvTool(d);
  return tool.execute('t1', { action: 'command', text } as never);
}
const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join(' ');

describe('«baja a la mitad»: frases', () => {
  it.each([
    'baja a la mitad',
    'Bájalo a la mitad',
    'baja el volumen a la mitad',
    'volumen a la mitad',
    'pon el volumen a la mitad',
    'el volumen a la mitad',
    'baja la tele a la mitad',
    'baja el volumen de la tele a la mitad',
    'déjalo a la mitad',
    'mitad de volumen',
    'baja a la mitad la tele',
  ])('«%s» → volumeHalf', (text) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volumeHalf' });
  });

  it.each(['sube a la mitad', 'volumen a 20', 'baja 5', 'sube a tope'])(
    '«%s» no es volumeHalf',
    (text) => {
      expect(parseTvCommand(text)?.action).not.toBe('volumeHalf');
    },
  );

  it('se describe en castellano', () => {
    expect(describeTvIntent({ action: 'volumeHalf' })).toBe('bajar el volumen a la mitad');
  });
});

describe('«baja a la mitad»: la tool lee el volumen y nunca sube', () => {
  it('con Glasshouse: pone floor(v/2) de una vez', async () => {
    const gh: Array<[string, unknown]> = [];
    const { deps: d, calls } = deps({
      status: async () => status(23),
      ghControl: async (a, v) => void gh.push([a, v]),
    });
    const r = await run(d, 'baja a la mitad');
    expect(gh).toEqual([['volume', 11]]);
    expect(calls).toEqual([]);
    expect(textOf(r)).toContain('de 23 a 11');
  });

  it('sin Glasshouse: baja con el mando exactamente lo que falta', async () => {
    const { deps: d, calls } = deps({ status: async () => status(10) });
    const r = await run(d, 'volumen a la mitad');
    expect(calls).toEqual(Array(5).fill('key:VOLUMEDOWN'));
    expect(textOf(r)).toContain('de 10 a 5');
  });

  it('sin Glasshouse y volumen alto: tope de pulsaciones y lo dice', async () => {
    const { deps: d, calls } = deps({ status: async () => status(80) });
    const r = await run(d, 'baja a la mitad');
    expect(calls.length).toBe(MAX_HALF_KEY_PRESSES);
    expect(calls.every((c) => c === 'key:VOLUMEDOWN')).toBe(true);
    expect(textOf(r)).toContain('volumen a 40');
  });

  it('volumen desconocido (apagada / sin respuesta): no toca nada', async () => {
    const gh: string[] = [];
    const { deps: d, calls } = deps({
      status: async () => status(null),
      ghControl: async (a) => void gh.push(a),
    });
    await expect(run(d, 'baja a la mitad')).rejects.toThrow(/no lo toco/);
    expect(calls).toEqual([]);
    expect(gh).toEqual([]);
  });

  it('status que lanza: no toca nada', async () => {
    const { deps: d, calls } = deps({
      status: async () => {
        throw new Error('timeout');
      },
    });
    await expect(run(d, 'baja a la mitad')).rejects.toThrow(/no lo toco/);
    expect(calls).toEqual([]);
  });

  it('instalacion sin status: no toca nada', async () => {
    const { deps: d, calls } = deps();
    await expect(run(d, 'baja a la mitad')).rejects.toThrow(/no lo toco/);
    expect(calls).toEqual([]);
  });

  it('a 0 o 1 no baja mas', async () => {
    for (const v of [0, 1]) {
      const gh: string[] = [];
      const { deps: d, calls } = deps({
        status: async () => status(v),
        ghControl: async (a) => void gh.push(a),
      });
      const r = await run(d, 'baja a la mitad');
      // 1 -> 0 es bajar; 0 se queda.
      if (v === 0) {
        expect(gh).toEqual([]);
        expect(textOf(r)).toContain('no lo bajo mas');
      } else expect(gh).toEqual(['volume']);
      expect(calls).toEqual([]);
    }
  });

  it('Glasshouse falla pero ya se aplico: no baja mas con el mando', async () => {
    const vols = [30, 15];
    const { deps: d, calls } = deps({
      status: async () => status(vols.shift() ?? 15),
      ghControl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const r = await run(d, 'baja a la mitad');
    expect(calls).toEqual([]);
    expect(textOf(r)).toContain('de 30 a 15');
  });

  it('Glasshouse falla y no se aplico: baja con el mando desde lo releido', async () => {
    const vols = [12, 12];
    const { deps: d, calls } = deps({
      status: async () => status(vols.shift() ?? 12),
      ghControl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await run(d, 'baja a la mitad');
    expect(calls).toEqual(Array(6).fill('key:VOLUMEDOWN'));
  });

  it('nunca manda VOLUMEUP ni sube el nivel', async () => {
    for (const v of [2, 7, 33, 50, 99, 100]) {
      const gh: Array<[string, unknown]> = [];
      const { deps: d, calls } = deps({
        status: async () => status(v),
        ghControl: async (a, x) => void gh.push([a, x]),
      });
      await run(d, 'baja a la mitad');
      expect(calls.some((c) => c.includes('UP'))).toBe(false);
      for (const [, x] of gh) expect(x as number).toBeLessThan(v);
    }
  });
});
