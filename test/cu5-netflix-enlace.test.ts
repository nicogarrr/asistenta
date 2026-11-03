/**
 * «pon en Netflix https://www.netflix.com/title/ID» abre ESE título
 * (asis-computeruse-5, pista 4 de cu4/HANDOFF.md). Antes se buscaba el texto
 * del enlace dentro de Netflix y no salía nada. Con fakes: LG (contentId de
 * ese título + captura), Roku (deep link ECP) y Samsung (DIAL).
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver } from '../src/tv/roku.js';
import { type SamsungSocket, samsungDriver } from '../src/tv/samsung.js';
import { appSearchRecipe, netflixContentId, netflixTitle } from '../src/tv/search-recipes.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);
function fakeDeps(over: Partial<TvToolDeps> = {}): TvToolDeps {
  return {
    shot: async () => ({ image: JPEG, mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
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
const hasImage = (r: { content: Array<{ type: string }> }) =>
  r.content.some((c) => c.type === 'image');
const texts = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');

const ID = '80057281';
const LINK = `https://www.netflix.com/title/${ID}`;
const fp = (text: string, tvNames: string[] = []) =>
  tvFastPathIntent({ text, now: 1, lastTvOrderAt: null, hasTv: true, tvNames });
const nfx = (text: string) => ({ action: 'search', text, appId: 'netflix' });

describe('enlace de Netflix → ese título, no una búsqueda del enlace', () => {
  it('reconoce /title/ID, /watch/ID, con idioma y con parámetros', () => {
    expect(netflixTitle(LINK)).toEqual({ id: ID, page: 'title' });
    expect(netflixTitle(`https://www.netflix.com/es/title/${ID}?s=a&trkid=1`)).toEqual({
      id: ID,
      page: 'title',
    });
    expect(netflixTitle(`https://www.netflix.com/es-en/title/${ID}`)?.id).toBe(ID);
    expect(netflixTitle(`https://netflix.com/watch/${ID}?trackId=2`)).toEqual({
      id: ID,
      page: 'watch',
    });
    expect(netflixTitle('dune')).toBeNull();
    expect(netflixTitle('https://www.netflix.com/browse')).toBeNull();
    expect(netflixTitle(`https://example.com/title/${ID}`)).toBeNull();
  });

  it('la receta de Netflix con un enlace abre su ficha; el texto se sigue buscando', () => {
    expect(appSearchRecipe('netflix', LINK)).toEqual({
      kind: 'contentId',
      appId: 'netflix',
      app: 'Netflix',
      contentId: `m=https://www.netflix.com/title/${ID}&source_type=4`,
      title: ID,
    });
    expect(netflixContentId(`https://www.netflix.com/watch/${ID}?x=1`)).toBe(
      `m=https://www.netflix.com/watch/${ID}&source_type=4`,
    );
    expect(appSearchRecipe('netflix', 'el año que vivimos')).toEqual({
      kind: 'contentId',
      appId: 'netflix',
      app: 'Netflix',
      contentId: 'm=https://www.netflix.com/search?q=el%20a%C3%B1o%20que%20vivimos&source_type=4',
    });
  });

  it('LG: una sola orden con ese título y la captura de después', async () => {
    const launchDeep = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ launchDeep }));
    const res = await tool.execute('t', { action: 'command', text: `pon en Netflix ${LINK}` });
    expect(launchDeep).toHaveBeenCalledTimes(1);
    expect(launchDeep).toHaveBeenCalledWith(
      'netflix',
      `m=https://www.netflix.com/title/${ID}&source_type=4`,
    );
    expect(hasImage(res)).toBe(true);
    expect(texts(res)).toContain(`título del enlace (${ID})`);
    expect(res.details).toMatchObject({ title: ID, recipe: 'contentId' });
  });

  it('órdenes con el enlace que entran al atajo sin modelo', () => {
    expect(parseTvCommand(`pon en Netflix ${LINK}`)).toEqual(nfx(LINK));
    expect(fp(`pon en Netflix ${LINK}`)).toEqual(nfx(LINK));
    expect(fp(`pon ${LINK} en la tele`)).toEqual(nfx(LINK));
    expect(fp(`pon en la tele este título ${LINK}`)).toEqual(nfx(LINK));
    expect(fp(`abre en la tele ${LINK}`)).toEqual(nfx(LINK));
    const long = `https://www.netflix.com/es/title/${ID}?s=i&trkid=258593161&vlang=es&clip=81499929`;
    expect(fp(`pon en Netflix ${long}`)).toEqual(nfx(long));
    // El mismo arreglo vale para YouTube: antes abría la app «en la tele enlacedelvideo».
    expect(fp('abre en la tele https://youtu.be/dQw4w9WgXcQ')).toEqual({
      action: 'search',
      text: 'https://youtu.be/dQw4w9WgXcQ',
      appId: 'youtube.leanback.v4',
    });
    expect(parseTvCommand('abre en la tele https://example.com/x')).toBeNull();
    // Nombrando la tele: el enlace sigue tal cual.
    expect(fp(`pon en Netflix ${LINK} en el salón`, ['Salón'])).toEqual(nfx(LINK));
  });

  it('un enlace solo, sin «tele» ni «Netflix», sigue al modelo (puede ser del PC)', () => {
    expect(fp(`pon ${LINK}`)).toBeNull();
    expect(fp(`abre ${LINK} en el navegador`)).toBeNull();
  });
});

describe('Roku y Samsung: el enlace abre el título', () => {
  it('Roku: launch/12 con contentId del título, en una petición', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const d = rokuDriver('192.168.1.30', { fetchImpl });
    const said = await runIntentOnDriver(d, nfx(LINK) as never);
    expect(calls).toEqual([
      `http://192.168.1.30:8060/launch/12?contentId=${ID}&mediaType=movie`,
      'http://192.168.1.30:8060/query/active-app',
    ]);
    expect(said).toBe('Roku: abriendo en Netflix el título del enlace.');
    calls.length = 0;
    await d.search?.('dune', 'netflix');
    expect(calls[0]).toContain('/search/browse?keyword=dune');
  });

  it('Samsung: 1 POST DIAL a Netflix con ese título (sin abrir el WebSocket)', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    const noSocket = (() => {
      throw new Error('no debe abrir el WebSocket');
    }) as unknown as (url: string) => SamsungSocket;
    const d = samsungDriver(
      { host: '192.168.1.61', secure: false },
      { fetchImpl, socketFactory: noSocket },
    );
    const said = await runIntentOnDriver(
      d,
      nfx(`https://www.netflix.com/watch/${ID}?t=1`) as never,
    );
    expect(calls).toEqual([
      {
        url: 'http://192.168.1.61:8080/ws/apps/Netflix',
        body: `m=https://www.netflix.com/watch/${ID}&source_type=4`,
      },
    ]);
    expect(said).toBe('Samsung: abriendo en Netflix el título del enlace.');
  });
});
