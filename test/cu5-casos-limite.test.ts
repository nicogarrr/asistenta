/**
 * Casos límite de los enlaces y títulos de la tele (#1941, #1946, #1948, #1954),
 * asis-computeruse-5. Antes «pon en YouTube youtu.be/ID» (el enlace sin
 * https://, como sale al copiarlo en el móvil) buscaba «youtu.be dqw4w9wgxcq»,
 * y «pon https://youtu.be/ID. en la tele» (con el punto de la frase) iba al modelo.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { tvFastPathIntent } from '../src/tv/fast-path.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { rokuDriver } from '../src/tv/roku.js';

const ID = 'dQw4w9WgXcQ';
const fp = (text: string, tvNames: string[] = []) =>
  tvFastPathIntent({ text, now: 1, lastTvOrderAt: null, hasTv: true, tvNames });
const yt = (text: string) => ({ action: 'search', text, appId: 'youtube.leanback.v4' });

describe('enlaces sin https:// y con la puntuación de la frase', () => {
  it.each([
    [`pon en YouTube youtu.be/${ID}`, `youtu.be/${ID}`],
    [`pon en YouTube www.youtube.com/watch?v=${ID}`, `www.youtube.com/watch?v=${ID}`],
    [`pon en YouTube m.youtube.com/watch?v=${ID}&t=90s`, `m.youtube.com/watch?v=${ID}&t=90s`],
    [`pon https://youtu.be/${ID}. en la tele`, `https://youtu.be/${ID}`],
    [`pon en YouTube https://youtu.be/${ID}, porfa`, `https://youtu.be/${ID}`],
    [`pon en YouTube https://youtu.be/${ID}!`, `https://youtu.be/${ID}`],
  ])('«%s» → el vídeo %s', (text, link) => {
    expect(parseTvCommand(text)).toEqual(yt(link));
    expect(fp(text)).toEqual(yt(link));
  });

  it('Netflix sin https:// también abre el título', () => {
    expect(fp('pon en Netflix netflix.com/es/title/80057281')).toEqual({
      action: 'search',
      text: 'netflix.com/es/title/80057281',
      appId: 'netflix',
    });
  });

  it('nombrando la tele el enlace sin https:// sigue tal cual (mayúsculas del id)', () => {
    expect(fp(`pon en YouTube youtu.be/${ID} en el salón`, ['Salón'])).toEqual(
      yt(`youtu.be/${ID}`),
    );
  });

  it('no se inventa enlaces: palabras con punto, correos y webs sin ruta', () => {
    expect(parseTvCommand('pon youtube.com en la tele')?.action).not.toBe('search');
    expect(parseTvCommand(`pon en YouTube yo@youtube.com/${ID}`)).not.toEqual(
      yt(`youtube.com/${ID}`),
    );
    expect(parseTvCommand('pon en YouTube Bailando')).toEqual(yt('bailando'));
  });

  it('LG: «pon en YouTube youtu.be/ID» pone ESE vídeo con su captura', async () => {
    const launchParams = vi.fn(async () => {});
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);
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
      text: `pon en YouTube youtu.be/${ID}`,
    });
    expect(launchParams).toHaveBeenCalledWith('youtube.leanback.v4', { contentTarget: `v=${ID}` });
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
  });
});

describe('títulos entre comillas (#1946): comillas rectas y tipográficas', () => {
  it.each([
    'pon en YouTube "Mañana" de Shakira',
    'pon en YouTube “Mañana” de Shakira',
    'pon en YouTube «Mañana» de Shakira',
  ])('«%s» busca, no se lee como hora', (text) => {
    expect(fp(text)).toEqual(yt('mañana de shakira'));
  });

  it('con una hora de verdad fuera de las comillas sigue siendo para luego (modelo)', () => {
    expect(fp('pon en YouTube «Mañana» mañana')).toBeNull();
  });
});

describe('lista de apps guardada (#1948): si la recarga falla, el mensaje de siempre', () => {
  it('Roku: la lista fresca no llega → «No encuentro» con la guardada, sin colgarse', async () => {
    let n = 0;
    const installedApps = vi.fn(async (o?: { fresh?: boolean }) => {
      n++;
      if (o?.fresh) throw new Error('sin red');
      return [{ id: '12', title: 'Netflix' }];
    });
    const fetchImpl = vi.fn(async () => new Response('')) as unknown as typeof fetch;
    const d = rokuDriver('192.168.1.60', { fetchImpl, installedApps });
    await expect(d.launch?.('rtve play')).rejects.toThrow(
      /No encuentro «rtve play» en el Roku\. Tiene: Netflix/,
    );
    expect(n).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
