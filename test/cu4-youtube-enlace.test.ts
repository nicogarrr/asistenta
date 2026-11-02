/**
 * «pon en YouTube <enlace>» y lo buscado con tildes al nombrar la tele
 * (asis-computeruse-4, pistas 1 de cu3/HANDOFF.md y casos límite de #1936).
 * Con fakes: en la LG el enlace pone ESE vídeo (contentTarget «v=ID»), no una
 * búsqueda del texto del enlace, y la respuesta sigue llevando la captura.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver } from '../src/tv/roku.js';
import { youtubeVideoId as samsungVideoId } from '../src/tv/samsung.js';
import { appSearchRecipe, youtubeVideoId } from '../src/tv/search-recipes.js';

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
const hasImage = (r: { content: Array<{ type: string }> }) =>
  r.content.some((c) => c.type === 'image');
const texts = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');

const ID = 'dQw4w9WgXcQ';
const LONG = `https://www.youtube.com/watch?v=${ID}&list=PLabcdefghijklmnopqrstuvwxyz012345&t=90s`;
const fp = (text: string, tvNames: string[] = []) =>
  tvFastPathIntent({ text, now: 1, lastTvOrderAt: null, hasTv: true, tvNames });
const yt = (text: string) => ({ action: 'search', text, appId: 'youtube.leanback.v4' });

describe('«pon en YouTube <enlace>» pone el vídeo, no busca el enlace', () => {
  it('la receta de YouTube con un enlace es contentTarget «v=ID»', () => {
    for (const link of [
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/watch?v=${ID}`,
      LONG,
      `https://m.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}?si=abc`,
    ]) {
      expect(appSearchRecipe('youtube.leanback.v4', link)).toMatchObject({
        kind: 'params',
        params: { contentTarget: `v=${ID}` },
        video: ID,
      });
    }
    // Texto normal: búsqueda de siempre.
    expect(appSearchRecipe('youtube.leanback.v4', 'bailando')).toMatchObject({
      params: { contentTarget: 'https://www.youtube.com/tv#/search?q=bailando' },
    });
    expect(samsungVideoId).toBe(youtubeVideoId);
  });

  it('LG: una sola orden con v=ID y la captura de después', async () => {
    const launchParams = vi.fn(async () => {});
    const tool = createTvTool(fakeDeps({ launchParams }));
    const res = await tool.execute('t', {
      action: 'command',
      text: `pon en YouTube https://youtu.be/${ID}`,
    });
    expect(launchParams).toHaveBeenCalledTimes(1);
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', { contentTarget: `v=${ID}` });
    expect(hasImage(res)).toBe(true);
    expect(texts(res)).toContain(`v=${ID}`);
    expect(res.details).toMatchObject({ video: ID, recipe: 'params' });
  });

  it('enlaces largos (&list, &t=90s) entran en el atajo y no se leen como hora', () => {
    expect(parseTvCommand(`pon en YouTube ${LONG}`)).toEqual(yt(LONG));
    expect(fp(`pon en YouTube ${LONG}`)).toEqual(yt(LONG));
  });

  it('«pon <enlace de YouTube> en la tele» y «reproduce este vídeo <enlace>»', () => {
    const short = `https://youtu.be/${ID}?si=AbCdEfGhIjKlMnOp`;
    expect(parseTvCommand(`pon ${short} en la tele`)).toEqual(yt(short));
    expect(fp(`pon ${short} en la tele`)).toEqual(yt(short));
    expect(fp(`reproduce este vídeo en la tele ${short}`)).toEqual(yt(short));
    expect(fp(`pon en la tele este enlace ${short}`)).toEqual(yt(short));
  });

  it('un enlace solo, sin «tele» ni «YouTube», sigue al modelo (puede ser del PC)', () => {
    expect(fp(`pon https://youtu.be/${ID}`)).toBeNull();
    expect(fp(`pon https://youtu.be/${ID} en el navegador`)).toBeNull();
    // Enlaces que no son de YouTube no se inventan app.
    expect(parseTvCommand('pon https://example.com/x en la tele')).toBeNull();
  });

  it('nombrando la tele, el id del vídeo conserva sus mayúsculas', () => {
    expect(fp(`pon en YouTube https://youtu.be/${ID} en el salón`, ['Salón'])).toEqual(
      yt(`https://youtu.be/${ID}`),
    );
    expect(fp(`pon en YouTube ${LONG} en la tele del salón`, ['Salón'])).toEqual(yt(LONG));
  });
});

describe('nombrando la tele, lo buscado conserva tildes y ñ (antes «pena»)', () => {
  it.each([
    ['pon en YouTube Peña en el salón', 'peña', 'youtube.leanback.v4'],
    [
      'busca El año que vivimos en Netflix en la tele del dormitorio',
      'el año que vivimos',
      'netflix',
    ],
    ['ponme en YouTube canción de Rosalía en el Dormitorio', 'rosalía', 'youtube.leanback.v4'],
  ])('«%s» → «%s»', (text, query, appId) => {
    expect(fp(text, ['Salón', 'Dormitorio'])).toEqual({ action: 'search', text: query, appId });
  });
});

describe('Roku: un enlace de YouTube abre ese vídeo', () => {
  it('launch/837 con contentId del vídeo, en una petición', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const d = rokuDriver('192.168.1.30', { fetchImpl });
    await d.search?.(`https://youtu.be/${ID}`, 'youtube.leanback.v4');
    expect(calls).toEqual([`http://192.168.1.30:8060/launch/837?contentId=${ID}&mediaType=movie`]);
    calls.length = 0;
    await d.search?.('bailando', 'youtube.leanback.v4');
    expect(calls[0]).toContain('/search/browse?keyword=bailando');
  });
});
