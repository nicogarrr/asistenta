/**
 * Casos límite de los atajos de tele recientes (#1892, #1927, #1930), con
 * fakes (asis-computeruse-3):
 * - tildes y ñ en lo que se busca («Peña» no es «pena», «año» no es «ano»);
 * - «en la tele del salón», «la del dormitorio» y varias teles;
 * - tele apagada del todo: «pon en YouTube X» la enciende por red y repite.
 * Toda orden que pone algo en la tele sigue devolviendo la captura.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvOrderRoute, type TvToolDeps } from '../src/tools/tv.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { TvUnreachableError } from '../src/tv/lgtv.js';
import { parseTvCommand, searchTextAsWritten } from '../src/tv/natural.js';
import type { KnownTv } from '../src/tv/registry.js';
import { extractTvTarget } from '../src/tv/target.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);
function fakeDeps(over: Partial<TvToolDeps> = {}): TvToolDeps {
  return {
    shot: async () => ({ image: JPEG, mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'youtube.leanback.v4', category: [] }),
    apps: async () => [],
    launch: async () => {},
    key: async () => {},
    toast: async () => {},
    power: async () => {},
    saveFrame: () => '/tmp/tv-1.jpg',
    getState: () => null,
    setState: () => {},
    ...over,
  };
}
const texts = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
const hasImage = (r: { content: Array<{ type: string }> }) =>
  r.content.some((c) => c.type === 'image');

const now = 1_000_000;
const base = { now, lastTvOrderAt: null, hasTv: true };
const KNOWN: KnownTv[] = [
  { host: '192.168.1.20', brand: 'lg', name: 'Salón', clientKey: 'k', secure: '1' },
  { host: '192.168.1.21', brand: 'samsung', name: 'Dormitorio', clientKey: '', secure: '1' },
  { host: '192.168.1.22', brand: 'roku', name: 'Habitación de Lucía', clientKey: '', secure: '1' },
];
const NAMES = KNOWN.map((t) => t.name ?? '');

describe('lo que se busca conserva tildes y ñ', () => {
  it.each([
    ['pon en YouTube Peña', 'peña'],
    ['pon en YouTube canción de Rosalía', 'rosalía'],
    ['busca en Netflix El año que vivimos', 'el año que vivimos'],
    ['pon Pequeña sirena en YouTube en la tele', 'pequeña sirena'],
    ['pon en YouTube Bailando de Enrique Iglesias', 'bailando de enrique iglesias'],
    ['PON EN YOUTUBE BAILANDO', 'bailando'],
  ])('«%s» → «%s»', (text, query) => {
    const intent = parseTvCommand(text);
    expect(intent?.action).toBe('search');
    expect(intent?.action === 'search' ? intent.text : null).toBe(query);
  });

  it('si no encuentra el tramo, la consulta normalizada de siempre', () => {
    expect(searchTextAsWritten('algo distinto', 'bailando')).toBe('bailando');
    expect(searchTextAsWritten('pon Bailando!!', 'bailando')).toBe('bailando');
  });

  it('la búsqueda en la tele lleva la ñ (no «pena»)', async () => {
    const launchParams = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ launchParams }));
    const res = await tool.execute('t', { action: 'command', text: 'pon en YouTube Peña' });
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', {
      contentTarget: `https://www.youtube.com/tv#/search?q=${encodeURIComponent('peña')}`,
    });
    expect(hasImage(res)).toBe(true);
  });
});

describe('«en la tele del salón» y varias teles en el atajo sin modelo', () => {
  const fp = (text: string) => tvFastPathIntent({ ...base, text, tvNames: NAMES });

  it('con o sin tilde, mayúsculas, «en», «de la», «del»', () => {
    expect(fp('baja el volumen de la tele del salon')).toEqual({
      action: 'volumeStep',
      steps: -3,
    });
    expect(fp('Baja el volumen en la tele del Salón')?.action).toBe('volumeStep');
    expect(fp('apaga la tele de la habitacion de Lucia')).toEqual({ action: 'power', on: false });
    expect(fp('pon en YouTube Bailando en la tele del salón')).toEqual({
      action: 'search',
      text: 'bailando',
      appId: 'youtube.leanback.v4',
    });
    expect(fp('ponme en Netflix La casa de papel en el salón')).toEqual({
      action: 'search',
      text: 'la casa de papel',
      appId: 'netflix',
    });
  });

  it('«enciende la del dormitorio» también va sin modelo (antes iba al modelo)', () => {
    expect(fp('enciende la del dormitorio')).toEqual({ action: 'power', on: true });
    expect(fp('apaga la del salón')).toEqual({ action: 'power', on: false });
  });

  it('con hora sigue al modelo aunque nombre la tele', () => {
    expect(fp('pon en YouTube Bailando en la tele del salón a las 9')).toBeNull();
  });

  it('la tool elige la tele por su nombre y quita la frase de lugar', () => {
    expect(extractTvTarget('pon en YouTube Bailando en la tele del salón', KNOWN)).toMatchObject({
      text: 'pon en YouTube Bailando en la tele',
      tv: { host: '192.168.1.20' },
    });
    expect(extractTvTarget('enciende la del dormitorio', KNOWN)).toMatchObject({
      text: 'enciende la tele',
      tv: { host: '192.168.1.21' },
    });
  });

  it('dos teles en una orden o una que no existe: pregunta y no toca ninguna', async () => {
    for (const text of [
      'sube el volumen de la tele del salón y del dormitorio',
      'pon Netflix en la tele del garaje',
    ]) {
      const found = extractTvTarget(text, KNOWN);
      expect(found.ask).toBeTruthy();
      const launch = vi.fn(async () => {});
      const key = vi.fn(async () => {});
      const routeOrder = async (t: string): Promise<TvOrderRoute> => {
        const r = extractTvTarget(t, KNOWN);
        return { text: r.text, ...(r.ask ? { ask: r.ask } : {}), run: (fn) => fn() };
      };
      const tool = createTvTool(fakeDeps({ launch, key, routeOrder }));
      const res = await tool.execute('t', { action: 'command', text });
      expect(res.details).toMatchObject({ asked: true });
      expect(launch).not.toHaveBeenCalled();
      expect(key).not.toHaveBeenCalled();
    }
  });
});

describe('tele apagada del todo: primero Wake-on-LAN, luego la orden', () => {
  const offOnce = () => {
    const off = true;
    return vi.fn(async () => {
      if (off) throw new TvUnreachableError('No se pudo conectar con la TV (192.168.1.20)');
    });
  };

  it('«pon en YouTube Bailando»: enciende por red, busca y devuelve la captura', async () => {
    const launchParams = offOnce();
    const power = vi.fn(async () => {
      (
        launchParams as unknown as { mockImplementation: (f: () => Promise<void>) => void }
      ).mockImplementation(async () => {});
      return { via: 'wol' as const, verified: true };
    });
    const tool = createTvTool(fakeDeps({ launchParams, power }));
    const res = await tool.execute('t', { action: 'command', text: 'pon en YouTube Bailando' });
    expect(power).toHaveBeenCalledWith(true);
    expect(launchParams).toHaveBeenCalledTimes(2);
    expect(texts(res)).toMatch(/apagada del todo: la he encendido por red/);
    expect(hasImage(res)).toBe(true);
    expect(res.details).toMatchObject({ woke: 'wol' });
  });

  it('«abre Netflix» con la tele apagada: igual, enciende y abre', async () => {
    let off = true;
    const launch = vi.fn(async () => {
      if (off) throw new TvUnreachableError('No se pudo conectar con la TV');
    });
    const power = vi.fn(async () => {
      off = false;
      return { via: 'wol' as const, verified: true };
    });
    const tool = createTvTool(fakeDeps({ launch, power }));
    const res = await tool.execute('t', { action: 'command', text: 'abre netflix en la tele' });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(texts(res)).toMatch(/Wake-on-LAN/);
  });

  it('sin MAC, o si sigue sin responder, el error de siempre y sin repetir', async () => {
    for (const power of [
      vi.fn(async () => {
        throw new Error('Para encender por red necesito la MAC');
      }),
      vi.fn(async () => ({ via: 'wol' as const, verified: false })),
      vi.fn(async () => {}),
    ]) {
      const launchParams = offOnce();
      const tool = createTvTool(fakeDeps({ launchParams, power }));
      await expect(
        tool.execute('t', { action: 'command', text: 'pon en YouTube Bailando' }),
      ).rejects.toThrow(/apagada del todo|No se pudo conectar/);
      expect(launchParams).toHaveBeenCalledTimes(1);
    }
  });

  it('un fallo que no es «no llego» (la orden pudo salir) no enciende ni repite', async () => {
    const launchParams = vi.fn(async () => {
      throw new Error('La TV rechazo la orden');
    });
    const power = vi.fn(async () => ({ via: 'wol' as const, verified: true }));
    const tool = createTvTool(fakeDeps({ launchParams, power }));
    await expect(
      tool.execute('t', { action: 'command', text: 'pon en YouTube Bailando' }),
    ).rejects.toThrow(/rechazo/);
    expect(power).not.toHaveBeenCalled();
  });

  it('volumen o teclas con la tele apagada no la encienden', async () => {
    const key = vi.fn(async () => {
      throw new TvUnreachableError('No se pudo conectar con la TV');
    });
    const power = vi.fn(async () => ({ via: 'wol' as const, verified: true }));
    const tool = createTvTool(fakeDeps({ key, power }));
    await expect(tool.execute('t', { action: 'command', text: 'pausa la tele' })).rejects.toThrow();
    expect(power).not.toHaveBeenCalled();
  });
});
