/**
 * Netflix: el enlace que sale en la barra del navegador al abrir una ficha
 * desde el inicio o el buscador es «netflix.com/browse?jbv=ID» (o
 * «/search?q=…&jbv=ID»), no /title/ID. Antes se buscaba el texto del enlace
 * dentro de Netflix (no salía nada) o iba al modelo; ahora abre ESE título como
 * los enlaces /title/ID de #1954 (asis-computeruse-6). Con fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { runIntentOnDriver } from '../src/tv/drivers.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver } from '../src/tv/roku.js';
import { samsungDriver } from '../src/tv/samsung.js';
import { appSearchRecipe, netflixTitle } from '../src/tv/search-recipes.js';

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

const ID = '80100172';
const BROWSE = `https://www.netflix.com/browse?jbv=${ID}`;
const SEARCH = `https://www.netflix.com/search?q=dark&jbv=${ID}&t=1`;
const nfx = (text: string) => ({ action: 'search', text, appId: 'netflix' });
const fp = (text: string) =>
  tvFastPathIntent({ text, now: 1, lastTvOrderAt: null, hasTv: true, tvNames: [] });

describe('Netflix «?jbv=ID» → ese título', () => {
  it('reconoce jbv en /browse, /search, /latest y sin https', () => {
    expect(netflixTitle(BROWSE)).toEqual({ id: ID, page: 'title' });
    expect(netflixTitle(SEARCH)).toEqual({ id: ID, page: 'title' });
    expect(netflixTitle(`netflix.com/latest?jbv=${ID}`)).toEqual({ id: ID, page: 'title' });
    expect(netflixTitle(`https://www.netflix.com/es/browse/genre/83?bc=1&jbv=${ID}`)?.id).toBe(ID);
    // Lo de antes sigue igual; sin jbv o con otro parámetro, no es un título.
    expect(netflixTitle(`https://www.netflix.com/title/${ID}`)).toEqual({ id: ID, page: 'title' });
    expect(netflixTitle('https://www.netflix.com/browse')).toBeNull();
    expect(netflixTitle(`https://www.netflix.com/browse?xjbv=${ID}`)).toBeNull();
    expect(netflixTitle(`https://www.netflix.com/browse?jbv=12`)).toBeNull();
    expect(netflixTitle(`https://example.com/browse?jbv=${ID}`)).toBeNull();
  });

  it('receta LG: la ficha de ese título, no una búsqueda del enlace', () => {
    expect(appSearchRecipe('netflix', BROWSE)).toEqual({
      kind: 'contentId',
      appId: 'netflix',
      app: 'Netflix',
      contentId: `m=https://www.netflix.com/title/${ID}&source_type=4`,
      title: ID,
    });
  });

  it('LG: una orden con ese título y la captura de después', async () => {
    const launchDeep = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ launchDeep }));
    const res = await tool.execute('t', { action: 'command', text: `pon en Netflix ${SEARCH}` });
    expect(launchDeep).toHaveBeenCalledWith(
      'netflix',
      `m=https://www.netflix.com/title/${ID}&source_type=4`,
    );
    expect(res.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
  });

  it('«pon <enlace jbv> en la tele» entra al atajo sin modelo', () => {
    expect(parseTvCommand(`pon ${BROWSE} en la tele`)).toEqual(nfx(BROWSE));
    expect(fp(`pon ${BROWSE} en la tele`)).toEqual(nfx(BROWSE));
    expect(fp(`abre en la tele ${SEARCH}`)).toEqual(nfx(SEARCH));
  });

  it('Roku: deep link de ese título', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const d = rokuDriver('192.168.1.70', { fetchImpl, confirmMs: 0 });
    await runIntentOnDriver(d, { action: 'search', text: BROWSE, appId: 'netflix' });
    expect(calls.some((c) => c.includes(`/launch/12?contentId=${ID}&mediaType=movie`))).toBe(true);
    expect(calls.some((c) => c.includes('search'))).toBe(false);
  });

  it('Samsung: DIAL con la ficha de ese título', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('', { status: 201 });
    }) as unknown as typeof fetch;
    const d = samsungDriver({ host: '192.168.1.71', secure: false }, { fetchImpl });
    await runIntentOnDriver(d, { action: 'search', text: BROWSE, appId: 'netflix' });
    expect(bodies).toEqual([`m=https://www.netflix.com/title/${ID}&source_type=4`]);
  });
});
