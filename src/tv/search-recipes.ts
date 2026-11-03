/**
 * Recetas de búsqueda por app de la tele (LG webOS): cómo buscar «X» DENTRO
 * de una app concreta sin navegar su teclado en pantalla.
 *
 * #1909 fijó el orden de vías para buscar contenido (búsqueda universal →
 * launch con contentId → teclado de la app). Faltaba la receta de cada app:
 * el modelo no sabía que YouTube acepta la búsqueda como parámetro de
 * arranque, así que acababa en la vía 3, tecla a tecla, con una captura por
 * paso (y el teclado propio de YouTube no acepta `type`).
 *
 * - YouTube (oficial y YouTube AdFree): `system.launcher/launch` con
 *   `params.contentTarget`, que la app trata como ruta de youtube.com/tv
 *   (webosbrew/youtube-webos src/utils.js; homebridge-webos-tv #335 para
 *   `v=ID`). Búsqueda: `https://www.youtube.com/tv#/search?q=…`.
 * - Netflix: `contentId` «m=<url>&source_type=4» (el formato DIAL que también
 *   usa webOS); la búsqueda va como https://www.netflix.com/search?q=….
 * - Movistar Plus+: no publica enlaces de arranque; su receta es el teclado,
 *   con la guía (action=guide) para saber el canal exacto antes.
 *
 * Las URLs de búsqueda no están verificadas en la tele de Nico: por eso
 * quien las usa SIEMPRE devuelve la captura de después para comprobarlo.
 */
export type TvSearchRecipe =
  | {
      kind: 'params';
      appId: string;
      app: string;
      params: Record<string, string>;
      /** Id del vídeo cuando lo pedido es un enlace de YouTube: se pone, no se busca. */
      video?: string;
    }
  | {
      kind: 'contentId';
      appId: string;
      app: string;
      contentId: string;
      /** Id del título cuando lo pedido es un enlace de Netflix: se abre, no se busca. */
      title?: string;
    }
  | { kind: 'keyboard'; appId: string; app: string; hint: string };

const YOUTUBE_IDS = new Set(['youtube.leanback.v4', 'org.webosbrew.youtube.adfree']);
const YT_TV = 'https://www.youtube.com/tv';
const MOVISTAR_ID = 'com.telefonica.app.nux';

const YT_VIDEO_ID =
  /(?:youtu\.be\/|[?&]v=|^v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/;

/** Id de vídeo de YouTube en lo pedido (enlace o «v=ID»), o null si es texto. */
export function youtubeVideoId(query: string): string | null {
  return YT_VIDEO_ID.exec(query.trim())?.[1] ?? null;
}

const NETFLIX_TITLE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?netflix\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(title|watch)\/(\d{4,12})(?!\d)/i;

/**
 * Título de Netflix en lo pedido («https://www.netflix.com/title/80057281»,
 * también /watch/ID y con idioma «/es/title/ID»), o null si es texto.
 */
export function netflixTitle(query: string): { id: string; page: 'title' | 'watch' } | null {
  const m = NETFLIX_TITLE.exec(query.trim());
  if (!m?.[1] || !m[2]) return null;
  return { id: m[2], page: m[1].toLowerCase() === 'watch' ? 'watch' : 'title' };
}

/**
 * Contenido «m=<url>&source_type=4» de Netflix (el formato DIAL que usan webOS
 * y la Samsung): un enlace abre ESE título (su ficha, o lo reproduce si era
 * /watch/ID); cualquier otro texto se busca.
 */
export function netflixContentId(query: string): string {
  const t = netflixTitle(query);
  const url = t
    ? `https://www.netflix.com/${t.page}/${t.id}`
    : `https://www.netflix.com/search?q=${encodeURIComponent(query.trim().slice(0, 200))}`;
  return `m=${url}&source_type=4`;
}

/** ¿Es una de las apps de YouTube de la tele (oficial o AdFree)? */
export function isYoutubeApp(appId: string): boolean {
  return YOUTUBE_IDS.has(appId);
}

/** Cómo buscar `query` dentro de `appId` (ya resuelto al id real), o null si no hay receta. */
export function appSearchRecipe(appId: string, query: string): TvSearchRecipe | null {
  const q = query.trim().slice(0, 200);
  if (!q) return null;
  if (isYoutubeApp(appId)) {
    const app = appId === 'youtube.leanback.v4' ? 'YouTube' : 'YouTube AdFree';
    // «pon en YouTube https://youtu.be/ID»: el vídeo exacto («v=ID», el mismo
    // contentTarget que el deeplink), no una búsqueda del texto del enlace.
    const video = youtubeVideoId(q);
    if (video)
      return { kind: 'params', appId, app, params: { contentTarget: `v=${video}` }, video };
    return {
      kind: 'params',
      appId,
      app,
      params: { contentTarget: `${YT_TV}#/search?q=${encodeURIComponent(q)}` },
    };
  }
  if (appId === 'netflix') {
    // «pon en Netflix https://www.netflix.com/title/ID»: ese título, no una
    // búsqueda del texto del enlace (que no encontraba nada).
    const title = netflixTitle(q);
    return {
      kind: 'contentId',
      appId,
      app: 'Netflix',
      contentId: netflixContentId(q),
      ...(title ? { title: title.id } : {}),
    };
  }
  if (appId === MOVISTAR_ID) {
    return {
      kind: 'keyboard',
      appId,
      app: 'Movistar Plus+',
      hint:
        'Movistar Plus+ no tiene enlace de búsqueda: si es un partido o un programa, mira antes ' +
        'el canal con action=guide; luego launch, ráfaga hasta su buscador y type con el nombre ' +
        'exacto, verificando cada paso con la captura.',
    };
  }
  return null;
}

const YT_VIDEO = /(?:^|[?&#/]|v=)([A-Za-z0-9_-]{11})(?:$|[&?#])/;

/**
 * Payload de `system.launcher/launch` para abrir un contenido exacto.
 *
 * YouTube en webOS lee `params.contentTarget` («v=ID»), no `contentId`: con
 * solo contentId la app se abría en su inicio. Se manda también contentId
 * (lo que ya se mandaba) para no romper a quien lo use así.
 */
export function deepLaunchPayload(
  appId: string,
  contentId: string,
): { id: string; contentId: string; params?: Record<string, string> } {
  if (!isYoutubeApp(appId)) return { id: appId, contentId };
  const c = contentId.trim();
  if (c.startsWith(`${YT_TV}`)) return { id: appId, contentId: c, params: { contentTarget: c } };
  const m = /^v=([A-Za-z0-9_-]{11})\b/.exec(c) ?? YT_VIDEO.exec(c);
  const target = m ? `v=${m[1]}` : c;
  return { id: appId, contentId: c, params: { contentTarget: target } };
}
