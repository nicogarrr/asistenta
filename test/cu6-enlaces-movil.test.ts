/**
 * Enlaces de YouTube/Netflix tal como llegan del móvil (asis-computeruse-6):
 * - «Youtu.be/ID» o «YouTu.be/ID» (mayúscula del autocorrector al principio):
 *   el id del vídeo no se reconocía y se buscaba el texto del enlace en
 *   YouTube (otro vídeo), o la orden iba al modelo.
 * - El enlace pegado y «en la tele», sin verbo («youtu.be/ID en la tele»), o
 *   con «ponlo/pónmelo»: iba al modelo (4–8 s). Ahora pone el vídeo/título.
 * Un enlace suelto, sin «tele», sigue sin tocar la tele.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { appSearchRecipe, deepLaunchPayload, youtubeVideoId } from '../src/tv/search-recipes.js';

const ID = 'dQw4w9WgXcQ';
const yt = (text: string) => ({ action: 'search', text, appId: 'youtube.leanback.v4' });
const fp = (text: string) =>
  tvFastPathIntent({ text, now: 1, lastTvOrderAt: null, hasTv: true, tvNames: [] });

describe('enlaces con mayúsculas o sin verbo', () => {
  it('el id sale aunque el dominio venga con mayúsculas (y el id no cambia)', () => {
    expect(youtubeVideoId(`Youtu.be/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://YouTu.be/${ID}?si=Ab`)).toBe(ID);
    expect(youtubeVideoId(`Youtube.com/watch?V=${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/Shorts/${ID}`)).toBe(ID);
    expect(youtubeVideoId('youtu.be/corto')).toBeNull();
    expect(deepLaunchPayload('youtube.leanback.v4', `v=${ID}`).params).toEqual({
      contentTarget: `v=${ID}`,
    });
  });

  it('«pon en YouTube Youtu.be/ID» pone ESE vídeo, no busca el texto del enlace', () => {
    expect(parseTvCommand(`pon en YouTube Youtu.be/${ID}`)).toEqual(yt(`Youtu.be/${ID}`));
    expect(appSearchRecipe('youtube.leanback.v4', `Youtu.be/${ID}`)).toEqual({
      kind: 'params',
      appId: 'youtube.leanback.v4',
      app: 'YouTube',
      params: { contentTarget: `v=${ID}` },
      video: ID,
    });
  });

  it('LG: una orden con ese vídeo y la captura', async () => {
    const launch = vi.fn(async () => {});
    const launchParams = vi.fn(async () => {});
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);
    const deps: TvToolDeps = {
      shot: async () => ({ image: JPEG, mimeType: 'image/jpeg' }),
      foreground: async () => ({ appId: 'youtube.leanback.v4', category: [] }),
      apps: async () => [],
      launch,
      launchParams,
      key: async () => {},
      toast: async () => {},
      power: async () => {},
      saveFrame: () => '/tmp/tv-1.jpg',
      getState: () => null,
      setState: () => {},
    };
    const res = await createTvTool(deps).execute('t', {
      action: 'command',
      text: `Youtu.be/${ID} en la tele`,
    });
    expect(launchParams).toHaveBeenCalledTimes(1);
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', { contentTarget: `v=${ID}` });
    expect(res.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
  });

  it('el enlace y «en la tele», sin verbo, o con «ponlo»: al atajo', () => {
    for (const t of [
      `Youtu.be/${ID} en la tele`,
      `https://youtu.be/${ID} en la tele`,
      `Https://youtu.be/${ID} en la tele.`,
      `https://youtu.be/${ID}, en la tv porfa`,
      `https://youtu.be/${ID} ponlo en la tele`,
      `pónmelo en la tele https://youtu.be/${ID}`,
    ]) {
      const link = /\S*youtu\S*?(?=[.,]?(?:\s|$))/i.exec(t)?.[0] ?? '';
      expect(parseTvCommand(t), t).toEqual(yt(link));
      expect(fp(t), t).toEqual(yt(link));
    }
    expect(parseTvCommand('https://www.netflix.com/title/80057281 en la tele')).toEqual({
      action: 'search',
      text: 'https://www.netflix.com/title/80057281',
      appId: 'netflix',
    });
  });

  it('sin «tele» o con otra cosa alrededor, no se pone nada', () => {
    expect(parseTvCommand(`https://youtu.be/${ID}`)).toBeNull();
    expect(parseTvCommand(`mira esto https://youtu.be/${ID} en la tele`)).toBeNull();
    expect(parseTvCommand(`https://youtu.be/${ID} en el móvil`)).toBeNull();
    expect(parseTvCommand('https://example.com/x en la tele')).toBeNull();
  });
});
