/**
 * Movistar Plus+ sin cuenta: qué echan y dónde, con fuentes públicas y gratis.
 *
 * - Guía (XMLTV): https://epg-spain.netlify.app/guide.xml (proyecto
 *   raulfdeztdo/epg, scraping diario de movistarplus.es; ~160 canales M+,
 *   48 h de parrilla). Sirve para «¿dónde echan el Ceuta-Sporting?».
 * - Canales (JSON): ottcache.dof6.com, el mismo CDN de Movistar que usa la
 *   web ver.movistarplus.es; no pide login para la lista de canales.
 *
 * Lo que NO hace (todavía): sintonizar el canal en la app de la tele ni
 * reproducir (eso pide los tokens de la cuenta de Nico). El salto a la app
 * se hace con las acciones de siempre: launch + buscar el canal por nombre
 * con type, verificando con la captura (look).
 */

const GUIDE_URL = 'https://epg-spain.netlify.app/guide.xml';
const CHANNELS_URL =
  'https://ottcache.dof6.com/movistarplus/webplayer/PT/contents/channels?mdrm=true&tlsstream=true&demarcation=13&version=8';
const CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
/** Margen hacia atrás: un partido empezado hace 3 h sigue "echándose". */
const STARTED_WITHIN_MS = 3 * 3_600_000;

export interface MovistarMatch {
  channelId: string;
  channelName: string;
  title: string;
  desc: string;
  start: Date;
  stop: Date;
  live: boolean;
}

interface GuideCache {
  at: number;
  programmes: RawProgramme[];
  channels: Map<string, string>;
}

interface RawProgramme {
  channelId: string;
  title: string;
  desc: string;
  start: Date;
  stop: Date;
}

let cache: GuideCache | null = null;

/** Quita acentos y baja a minúsculas para comparar sin sustos. */
export function normalizeTvText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** «20261102103000 +0000» (XMLTV) → Date. */
export function parseXmltvDate(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, tz] = m;
  const off = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '+00:00';
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}${off}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parseo mínimo de XMLTV sin dependencias (la guía pesa ~4 MB). */
export function parseXmltvGuide(xml: string): {
  programmes: RawProgramme[];
  channels: Map<string, string>;
} {
  const channels = new Map<string, string>();
  for (const m of xml.matchAll(/<channel id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    const name = (m[2] ?? '').match(/<display-name[^>]*>([^<]+)<\/display-name>/);
    if (name?.[1]) channels.set(m[1] ?? '', unescapeXml(name[1].trim()));
  }
  const programmes: RawProgramme[] = [];
  for (const m of xml.matchAll(
    /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/g,
  )) {
    const start = parseXmltvDate(m[1] ?? '');
    const stop = parseXmltvDate(m[2] ?? '');
    if (!start || !stop) continue;
    const title = (m[4] ?? '').match(/<title[^>]*>([^<]*)<\/title>/);
    const desc = (m[4] ?? '').match(/<desc[^>]*>([^<]*)<\/desc>/);
    programmes.push({
      channelId: m[3] ?? '',
      title: unescapeXml((title?.[1] ?? '').trim()),
      desc: unescapeXml((desc?.[1] ?? '').trim()),
      start,
      stop,
    });
  }
  return { programmes, channels };
}

async function fetchText(url: string, fetchImpl?: typeof fetch): Promise<string> {
  const f = fetchImpl ?? fetch;
  const res = await f(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} al pedir la guía de Movistar`);
  return res.text();
}

async function loadGuide(fetchImpl?: typeof fetch): Promise<GuideCache> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const xml = await fetchText(GUIDE_URL, fetchImpl);
  const { programmes, channels } = parseXmltvGuide(xml);
  if (programmes.length === 0) {
    throw new Error('La guía de Movistar vino vacía o con otro formato; hay que revisarla.');
  }
  cache = { at: Date.now(), programmes, channels };
  return cache;
}

/**
 * Busca qué echan (o echarán en 48 h) en Movistar Plus+: todas las palabras
 * de la consulta deben salir en título o descripción, sin acentos. Devuelve
 * hasta `limit` coincidencias ordenadas por hora, con el canal resuelto.
 */
export async function movistarFind(
  query: string,
  opts: { now?: Date; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<MovistarMatch[]> {
  const words = normalizeTvText(query)
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return [];
  const now = opts.now ?? new Date();
  const { programmes, channels } = await loadGuide(opts.fetchImpl);
  const matches: MovistarMatch[] = [];
  for (const p of programmes) {
    if (p.stop.getTime() < now.getTime() - STARTED_WITHIN_MS) continue;
    if (p.start.getTime() > now.getTime() + 48 * 3_600_000) continue;
    const hay = normalizeTvText(`${p.title} ${p.desc}`);
    if (!words.every((w) => hay.includes(w))) continue;
    matches.push({
      channelId: p.channelId,
      channelName: channels.get(p.channelId) ?? p.channelId,
      title: p.title,
      desc: p.desc,
      start: p.start,
      stop: p.stop,
      live: p.start.getTime() <= now.getTime() && p.stop.getTime() > now.getTime(),
    });
    if (matches.length >= (opts.limit ?? 8)) break;
  }
  // En emisión primero, luego por hora de comienzo.
  matches.sort((a, b) =>
    a.live === b.live ? a.start.getTime() - b.start.getTime() : a.live ? -1 : 1,
  );
  return matches;
}

/** Lista de canales de Movistar Plus+ (nombre ↔ ids), sin login. */
export async function movistarChannels(
  fetchImpl?: typeof fetch,
): Promise<Array<{ nombre: string; uid: number; cod: string }>> {
  const raw = await fetchText(CHANNELS_URL, fetchImpl);
  const data = JSON.parse(raw) as Array<{ Nombre?: string; Uid?: number; CodCadenaTv?: string }>;
  return data
    .filter((c) => c.Nombre && c.Uid)
    .map((c) => ({
      nombre: String(c.Nombre),
      uid: Number(c.Uid),
      cod: String(c.CodCadenaTv ?? ''),
    }));
}
