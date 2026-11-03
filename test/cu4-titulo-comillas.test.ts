/**
 * Títulos entre comillas en las órdenes de tele (asis-computeruse-4, pista 2
 * de cu3/HANDOFF.md): «pon en YouTube «Mañana» de Shakira» se leía como una
 * orden para mañana y se iba al modelo. Entre comillas es el título.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { parseTvCommand, tvOrderHasTime } from '../src/tv/natural.js';

const fp = (text: string, tvNames: string[] = []) =>
  tvFastPathIntent({ text, now: 1, lastTvOrderAt: null, hasTv: true, tvNames });
const yt = (text: string) => ({ action: 'search', text, appId: 'youtube.leanback.v4' });

describe('un título entre comillas no es una hora', () => {
  it.each([
    ['pon en YouTube «Mañana» de Shakira', 'mañana de shakira'],
    ['pon en YouTube "Mañana" de Shakira', 'mañana de shakira'],
    ['pon en YouTube “Mañana” de Shakira', 'mañana de shakira'],
    ['ponme en YouTube «Lunes» de Fito', 'lunes de fito'],
    ['pon «Esta noche» en YouTube', 'esta noche'],
  ])('«%s» → búsqueda «%s» sin modelo', (text, query) => {
    expect(tvOrderHasTime(text)).toBe(false);
    expect(parseTvCommand(text)).toEqual(yt(query));
    expect(fp(text)).toEqual(yt(query));
  });

  it('Netflix y nombrando la tele también', () => {
    expect(fp('pon en Netflix «Mañana es hoy» en el salón', ['Salón'])).toEqual({
      action: 'search',
      text: 'mañana es hoy',
      appId: 'netflix',
    });
    expect(fp('pon en YouTube «Mañana» de Shakira en la tele del salón', ['Salón'])).toEqual(
      yt('mañana de shakira'),
    );
  });

  it('la hora FUERA de las comillas sigue siendo una hora (al modelo, sin tocar la tele)', () => {
    expect(tvOrderHasTime('pon en YouTube «Despacito» mañana')).toBe(true);
    expect(fp('pon en YouTube «Despacito» mañana')).toBeNull();
    expect(fp('pon en YouTube «Despacito» a las 9')).toBeNull();
    // Sin comillas sigue ambiguo: al modelo, como antes.
    expect(fp('pon en YouTube Mañana de Shakira')).toBeNull();
  });

  it('las comillas solo valen para buscar: «apaga la tele "mañana"» no se ejecuta', () => {
    expect(parseTvCommand('apaga la tele «mañana»')).toBeNull();
  });

  it('en la tele: una sola orden de búsqueda y la captura de después', async () => {
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);
    const launchParams = vi.fn(async () => {});
    const deps: TvToolDeps = {
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
      launchParams,
    };
    const res = await createTvTool(deps).execute('t', {
      action: 'command',
      text: 'pon en YouTube «Mañana» de Shakira',
    });
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', {
      contentTarget: `https://www.youtube.com/tv#/search?q=${encodeURIComponent('mañana de shakira')}`,
    });
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
  });
});
