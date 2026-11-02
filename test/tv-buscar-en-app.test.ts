/**
 * Buscar dentro de una app con palabras: «busca Bailando en YouTube», «pon en
 * YouTube X», «pon el tráiler de Dune en Netflix». En la LG va por la receta
 * directa (search-recipes.ts); en un Roku por su búsqueda ECP (/search/browse).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver, rokuSearchPath } from '../src/tv/roku.js';
import { samsungDriver } from '../src/tv/samsung.js';

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

describe('parseTvCommand: buscar dentro de YouTube o Netflix', () => {
  it.each([
    ['busca Bailando en YouTube', 'bailando', 'youtube.leanback.v4'],
    [
      'pon en YouTube Bailando de Enrique Iglesias',
      'bailando de enrique iglesias',
      'youtube.leanback.v4',
    ],
    [
      'ponme en youtube el vídeo de la receta de croquetas',
      'la receta de croquetas',
      'youtube.leanback.v4',
    ],
    ['pon Bailando en YouTube', 'bailando', 'youtube.leanback.v4'],
    ['busca en Netflix La casa de papel', 'la casa de papel', 'netflix'],
    ['pon el tráiler de Dune en Netflix', 'dune', 'netflix'],
  ])('«%s»', (text, query, appId) => {
    expect(parseTvCommand(text)).toEqual({ action: 'search', text: query, appId });
  });

  it('lo que no es una búsqueda sigue como antes', () => {
    expect(parseTvCommand('pon youtube')).toEqual({ action: 'launch', appId: 'youtube' });
    expect(parseTvCommand('abre netflix')).toEqual({ action: 'launch', appId: 'netflix' });
    expect(parseTvCommand('pon la tele en youtube')?.action).not.toBe('search');
    expect(parseTvCommand('pon algo en youtube')).toBeNull();
    expect(parseTvCommand('busca bailando')).toBeNull();
    // Movistar Plus+ no tiene búsqueda directa: al modelo (guía + teclado).
    expect(parseTvCommand('pon el partido en movistar')?.action).not.toBe('search');
    // Con hora o condición, nunca al momento.
    expect(parseTvCommand('pon en youtube bailando a las 9')).toBeNull();
  });

  it('se describe en castellano', () => {
    expect(
      describeTvIntent({ action: 'search', text: 'bailando', appId: 'youtube.leanback.v4' }),
    ).toBe('buscar «bailando» en YouTube');
  });
});

describe('Roku: búsqueda ECP', () => {
  it('ruta con keyword y, con app conocida, provider-id y launch', () => {
    expect(rokuSearchPath('bailando', 'youtube.leanback.v4')).toBe(
      '/search/browse?keyword=bailando&provider-id=837&launch=true',
    );
    expect(rokuSearchPath('la casa de papel')).toBe('/search/browse?keyword=la+casa+de+papel');
    expect(() => rokuSearchPath('  ')).toThrow(/Qué busco/);
  });

  it('runIntentOnDriver manda UN POST a /search/browse en vez de teclear', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(`${init?.method} ${String(url)}`);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const said = await runIntentOnDriver(rokuDriver('192.168.1.80', { fetchImpl }), {
      action: 'search',
      text: 'dune',
      appId: 'netflix',
    });
    expect(urls).toEqual([
      'POST http://192.168.1.80:8060/search/browse?keyword=dune&provider-id=12&launch=true',
    ]);
    expect(said).toBe('Roku: buscando «dune».');
  });

  it('Samsung: texto dentro de YouTube no se puede: lo dice sin tocar la tele', async () => {
    // Netflix y los enlaces de YouTube van por DIAL (test/cu3-samsung-dial.test.ts).
    await expect(
      runIntentOnDriver(samsungDriver({ host: '192.168.1.70', secure: true }), {
        action: 'search',
        text: 'dune',
        appId: 'youtube.leanback.v4',
      }),
    ).rejects.toThrow(/no deja buscar texto dentro de YouTube/);
  });
});

describe('tool tv action=command con una búsqueda', () => {
  it('LG: «busca Bailando en YouTube» abre la búsqueda de YouTube en una orden', async () => {
    const launchParams = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ launchParams }));
    const res = await tool.execute('t', { action: 'command', text: 'busca Bailando en YouTube' });
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', {
      contentTarget: 'https://www.youtube.com/tv#/search?q=bailando',
    });
    expect(res.content[0]).toEqual({
      type: 'text',
      text: 'Entendido: buscar «bailando» en YouTube.',
    });
  });

  it('Roku: va por su driver (búsqueda ECP)', async () => {
    const search = vi.fn(async () => {});
    const tool = createTvTool(
      fakeDeps({
        routeOrder: async (text) => ({
          text,
          label: 'dormitorio',
          run: (fn) => fn(),
          intentRunner: (intent) =>
            runIntentOnDriver(
              {
                brand: 'Roku',
                power: async () => {},
                volumeStep: async () => {},
                mute: async () => undefined,
                key: async () => {},
                search,
              },
              intent,
            ),
        }),
      }),
    );
    await tool.execute('t', { action: 'command', text: 'pon en youtube bailando' });
    expect(search).toHaveBeenCalledWith('bailando', 'youtube.leanback.v4');
  });
});
