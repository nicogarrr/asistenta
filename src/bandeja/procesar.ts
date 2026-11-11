/**
 * Procesado de cada cosa de la bandeja, al llegar y en segundo plano: saca el
 * contenido (subtítulos o audio del vídeo, texto del post de X, del artículo o del
 * PDF, la captura, la ficha del libro), mide lo que cuesta (minutos, páginas) y pide
 * al modelo el veredicto (veredicto.ts). Sin reintentos automáticos: lo que falla se
 * queda en «error» con su motivo y Nico puede pulsar «⚡ Míralo ya» para repetirlo.
 *
 * Todo llega por `deps` (red, modelo, Telegram), así que los tests no tocan nada real.
 */

import type { VideoText } from '../media/resumen-video.js';
import { xVideoUrl } from '../media/resumen-video.js';
import { officeKind } from '../memory/office.js';
import { decodeEntities, extractMainContent, extractText } from '../tools/fetch.js';
import {
  type BandejaKind,
  type CaptureCandidate,
  canonicalKey,
  extractUrls,
  kindOfUrl,
} from './captura.js';
import { type FetchRaw, goodreadsLookup, openLibraryLookup } from './goodreads.js';
import type { BandejaExtra, BandejaItem, BandejaStore, Goodreads, ProcessResult } from './store.js';
import { directTags, parseVerdict, verdictPrompt } from './veredicto.js';

export type BandejaComplete = (
  systemPrompt: string,
  user: string,
  opts: {
    maxTokens: number;
    signal?: AbortSignal;
    images?: Array<{ type: 'image'; mimeType: string; data: string }>;
  },
) => Promise<string>;

export interface ProcesarDeps {
  /** El modelo del agente; sin modelo no hay veredicto (error claro). */
  complete: () => Promise<BandejaComplete | undefined>;
  /** HTML/JSON crudo de una URL pública (fetchPage con format html en el daemon). */
  fetchRaw: FetchRaw;
  /**
   * Texto real de un vídeo o audio: subtítulos de YouTube y, si no hay, el audio
   * transcrito con el whisper local (getVideoText de media/resumen-video.ts).
   * `directAudio`: el enlace es un mp3 (el del RSS de un podcast).
   */
  videoText: (
    url: string,
    opts?: { signal?: AbortSignal; directAudio?: boolean },
  ) => Promise<VideoText>;
  /** Bytes de un fichero de Telegram (PDF, foto). */
  download?: (fileId: string) => Promise<Buffer | null>;
  /** Texto de un PDF (una página por bloque separado por línea en blanco). */
  pdfText?: (bytes: Buffer) => Promise<string>;
  /** Texto de un EPUB, DOCX u ODT (el lector de memory/office.ts). */
  docText?: (bytes: Buffer, mimeType?: string, name?: string) => Promise<string>;
  /** «Tus temas» de Nico, para etiquetar. */
  temas?: () => readonly string[];
  /** Una captura con varias cosas se parte en una por cosa (las guarda el daemon). */
  addChild?: (
    parent: BandejaItem,
    child: CaptureCandidate,
  ) => { item: BandejaItem; dup: boolean } | null;
  /** Una cosa recién juzgada (para mandar solo lo 🔴 al Kindle con «kindle auto»). */
  onDone?: (item: BandejaItem) => void | Promise<void>;
  now?: () => Date;
  /** Tope de la transcripción de una cosa (por defecto TRANSCRIBE_BUDGET_MS; tests). */
  transcribeBudgetMs?: number;
}

/** Lo que entra al modelo: no más (un vídeo de 3 h son ~150 000 caracteres). */
export const MAX_CONTENT_CHARS = 60_000;
/** Palabras por minuto de lectura en pantalla. */
export const WORDS_PER_MIN = 230;
/** Una página de libro ≈ 300 palabras. */
const WORDS_PER_BOOK_PAGE = 300;

export class BandejaError extends Error {}

/** Una captura que era una lista: ya está partida y no lleva veredicto propio. */
export class BandejaSplit extends Error {
  readonly children: number[];
  readonly dups: number;
  constructor(children: number[], dups: number) {
    super('captura desglosada');
    this.children = children;
    this.dups = dups;
  }
}

function cap(text: string, max = MAX_CONTENT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  return `${text.slice(0, head)}\n[… recortado …]\n${text.slice(text.length - (max - head))}`;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_MIN));
}

/** «45 min», «1 h 20 min», «9 h». */
export function minutesLabel(min: number): string {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h >= 5 || r === 0) return `${Math.round(m / 60)} h`;
  return `${h} h ${r} min`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'web';
  }
}

function metaContent(html: string, prop: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    'i',
  );
  const m = re.exec(html);
  const v = m?.[1] ?? m?.[2];
  return v ? decodeEntities(v).trim() : null;
}

export function pageTitle(html: string): string | null {
  const og = metaContent(html, 'og:title');
  if (og) return og;
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? decodeEntities(t).replace(/\s+/g, ' ').trim() || null : null;
}

/** Un PDF original que la propia página ofrece (citation_pdf_url, arXiv, enlace .pdf). */
export function originalPdfUrl(url: string, html = ''): string | null {
  try {
    const u = new URL(url);
    if (/\.pdf$/i.test(u.pathname)) return url;
    const arxiv = /^\/abs\/([\w.\-/]+?)(v\d+)?$/.exec(u.pathname);
    if (u.hostname.endsWith('arxiv.org') && arxiv)
      return `https://arxiv.org/pdf/${arxiv[1]}${arxiv[2] ?? ''}`;
  } catch {
    return null;
  }
  const meta = metaContent(html, 'citation_pdf_url');
  if (meta && /^https:\/\//i.test(meta)) return meta;
  const alt = /<link[^>]+type=["']application\/pdf["'][^>]*href=["'](https:\/\/[^"']+)["']/i.exec(
    html,
  )?.[1];
  return alt ?? null;
}

interface Content {
  title: string | null;
  text: string;
  costMin: number | null;
  costLabel: string | null;
  extra: BandejaExtra;
  /** Qué es, para el modelo («Vídeo de YouTube de 23 min de Fulano»). */
  describe: string;
  images?: Array<{ type: 'image'; mimeType: string; data: string }>;
  /** Enlace que se descubrió por el camino (un vídeo que llegó como título de una captura). */
  url?: string;
}

/** Palabras con significado de un título, para comparar dos títulos. */
function titleWords(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Parecido de dos títulos (0–1): palabras de `a` que están en `b`. */
export function titleOverlap(a: string, b: string): number {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0) return 0;
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / wa.size;
}

function jsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Primer vídeo de la búsqueda de YouTube: id y título (la página pública de resultados). */
export function parseYoutubeSearch(html: string): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  const re =
    /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,800}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  for (const m of html.matchAll(re)) {
    if (m[1] && !out.some((o) => o.id === m[1]))
      out.push({ id: m[1], title: jsonString(m[2] ?? '') });
    if (out.length >= 5) break;
  }
  return out;
}

async function searchYoutube(
  deps: ProcesarDeps,
  query: string,
  mustMatch: string,
): Promise<string | null> {
  try {
    const html = await deps.fetchRaw(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    );
    const hit = parseYoutubeSearch(html).find((r) => titleOverlap(mustMatch, r.title) >= 0.6);
    return hit ? `https://www.youtube.com/watch?v=${hit.id}` : null;
  } catch {
    return null;
  }
}

/**
 * videoText que nunca lanza: un fallo raro dentro de la escalera de transcripción (YouTube
 * devolviendo una página HTML donde se esperaba JSON) es «sin transcripción», no un error
 * de la cosa entera (en el e2e, 3 vídeos se quedaban en ⚠️ por eso).
 */
async function safeVideoText(
  deps: ProcesarDeps,
  url: string,
  opts: { signal?: AbortSignal; directAudio?: boolean },
): ReturnType<ProcesarDeps['videoText']> {
  // La transcripción tiene su propio tope, por debajo del de la cosa entera: lo que dé
  // tiempo a oír se juzga («solo los primeros N min») y queda margen para el modelo.
  const budget = AbortSignal.timeout(deps.transcribeBudgetMs ?? TRANSCRIBE_BUDGET_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
  try {
    return await deps.videoText(url, { ...opts, signal });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return {
      ok: false,
      reason: `YouTube contestó algo raro (${String(err instanceof Error ? err.message : err).slice(0, 60)})`,
    } as Awaited<ReturnType<ProcesarDeps['videoText']>>;
  }
}

interface YoutubePage {
  title?: string;
  author?: string;
  description?: string;
  durationSeconds?: number;
  views?: number;
}

/** Lo que dice la página pública del vídeo (oEmbed + ficha): el último recurso. */
async function youtubePage(deps: ProcesarDeps, url: string): Promise<YoutubePage> {
  const out: YoutubePage = {};
  try {
    const o = JSON.parse(
      await deps.fetchRaw(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
      ),
    ) as {
      title?: string;
      author_name?: string;
    };
    if (o.title) out.title = o.title;
    if (o.author_name) out.author = o.author_name;
  } catch {
    // Sin oEmbed: se sigue con la ficha.
  }
  try {
    const html = await deps.fetchRaw(url);
    const short = /"shortDescription":"((?:[^"\\]|\\.)*)"/.exec(html)?.[1];
    const attributed = /"attributedDescriptionBodyText":\{"content":"((?:[^"\\]|\\.)*)"/.exec(
      html,
    )?.[1];
    const desc = short ?? attributed;
    if (desc) out.description = jsonString(desc).slice(0, 6000);
    const len = /"lengthSeconds":"(\d+)"/.exec(html)?.[1];
    if (len) out.durationSeconds = Number(len);
    const views = /"viewCount":"(\d+)"/.exec(html)?.[1];
    if (views) out.views = Number(views);
    if (!out.title) out.title = pageTitle(html)?.replace(/ - YouTube$/, '') ?? undefined;
  } catch {
    // Nada más que leer.
  }
  return out;
}

function viewsLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')} M visualizaciones`;
  if (n >= 1000) return `${Math.round(n / 1000)} mil visualizaciones`;
  return `${n} visualizaciones`;
}

async function videoContent(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
  urlOverride?: string,
): Promise<Content> {
  let url = urlOverride ?? item.url ?? '';
  let found: string | undefined;
  // Un vídeo que llegó solo con su título (de una captura): se busca en YouTube.
  if (!url && item.kind === 'youtube' && item.title) {
    const hit = await searchYoutube(deps, `${item.title} ${item.note ?? ''}`.trim(), item.title);
    if (!hit) throw new BandejaError(`no encontré en YouTube «${item.title}»`);
    url = hit;
    found = hit;
  }
  const site = item.kind === 'x' ? 'X' : 'YouTube';
  const v = await safeVideoText(deps, url, { signal });
  if (v.ok) {
    const mins = v.meta.durationSeconds ? v.meta.durationSeconds / 60 : null;
    return {
      title: v.meta.title || null,
      text: v.text,
      costMin: mins,
      costLabel: mins ? `🎬 ${minutesLabel(mins)}` : '🎬 duración desconocida',
      extra: { author: v.meta.author, source: site, basis: 'transcripcion' },
      describe: `Vídeo de ${site} «${v.meta.title}» de ${v.meta.author}${mins ? `, ${Math.round(mins)} min` : ''}, con su transcripción ${v.source === 'subtitulos' ? 'de los subtítulos' : 'sacada del audio'}${v.cappedAtMin ? ` (solo los primeros ${v.cappedAtMin} min)` : ''}.`,
      ...(found ? { url: found } : {}),
    };
  }
  if (item.kind !== 'youtube')
    throw new BandejaError(`no pude sacar el texto del vídeo: ${v.reason}`);
  // Último recurso, y avisado: la descripción de la ficha del vídeo.
  const page = await youtubePage(deps, url);
  if (!page.description || words(page.description) < 25)
    throw new BandejaError(`no pude sacar el texto del vídeo: ${v.reason}`);
  const mins = page.durationSeconds ? page.durationSeconds / 60 : null;
  return {
    title: page.title ?? null,
    text: `Descripción del vídeo (no hay transcripción):\n${page.description}`,
    costMin: mins,
    costLabel: mins ? `🎬 ${minutesLabel(mins)}` : '🎬 vídeo',
    extra: {
      ...(page.author ? { author: page.author } : {}),
      source: site,
      basis: 'descripcion',
      basisReason: v.reason,
      ...(page.views ? { publicRating: `👁️ ${viewsLabel(page.views)} en YouTube` } : {}),
    },
    describe: `Vídeo de YouTube «${page.title ?? '?'}»${page.author ? ` de ${page.author}` : ''}. OJO: no hay transcripción (${v.reason}); solo tienes su descripción: sé prudente y dilo en el MOTIVO.`,
    ...(found ? { url: found } : {}),
  };
}

interface FxTweet {
  text?: string;
  author?: { name?: string; screen_name?: string };
  media?: { videos?: Array<{ duration?: number }> };
  quote?: { text?: string; author?: { screen_name?: string } };
  article?: { title?: string; preview_text?: string };
  likes?: number;
  views?: number;
}

/** Post de X: su texto por la API pública de fxtwitter y, si trae vídeo, su transcripción. */
async function xContent(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<Content> {
  const canonical = xVideoUrl(item.url ?? '') ?? item.url ?? '';
  const m = /x\.com\/([^/]+)\/status\/(\d+)/.exec(canonical);
  let tweet: FxTweet | null = null;
  if (m) {
    try {
      const raw = await deps.fetchRaw(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`);
      tweet = (JSON.parse(raw) as { tweet?: FxTweet }).tweet ?? null;
    } catch {
      tweet = null;
    }
  }
  const hasVideo = (tweet?.media?.videos?.length ?? 0) > 0;
  let videoFail = '';
  if (!tweet || hasVideo) {
    // Sin texto (API caída) o con vídeo: el vídeo es lo que cuenta.
    try {
      const v = await videoContent(item, deps, signal);
      if (tweet?.text)
        v.text = `Texto del post: ${tweet.text}\n\nTranscripción del vídeo:\n${v.text}`;
      return v;
    } catch (err) {
      if (!tweet) throw err;
      videoFail = err instanceof Error ? err.message : String(err);
    }
  }
  if (!tweet?.text) throw new BandejaError('no pude leer el post de X');
  const author = tweet.author?.screen_name
    ? `@${tweet.author.screen_name}`
    : (tweet.author?.name ?? '');
  const parts = [tweet.text];
  if (tweet.quote?.text)
    parts.push(`Cita a @${tweet.quote.author?.screen_name ?? '?'}: ${tweet.quote.text}`);
  if (tweet.article?.title)
    parts.push(`Artículo: ${tweet.article.title}. ${tweet.article.preview_text ?? ''}`);
  if (item.note) parts.push(`Contexto con el que llegó: ${item.note}`);
  const text = parts.join('\n\n');
  const mins = readingMinutes(words(text));
  return {
    title: null,
    text,
    costMin: hasVideo ? null : mins,
    costLabel: hasVideo ? '🐦 post con vídeo' : `🐦 ${minutesLabel(mins)}`,
    extra: {
      author,
      source: 'X',
      basis: hasVideo ? 'descripcion' : 'texto',
      ...(hasVideo
        ? { basisReason: videoFail.replace(/^no pude sacar el texto del vídeo: /, '') }
        : {}),
    },
    describe: hasVideo
      ? `Post de X de ${author} con un vídeo que no pude transcribir (${videoFail}): solo tienes el texto del post; sé prudente y dilo en el MOTIVO.`
      : `Post de X de ${author}.`,
  };
}

/** Spotify: título y programa de la ficha; la transcripción, de la misma entrega en YouTube o en el RSS. */
async function podcastContent(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<Content> {
  const url = item.url ?? '';
  let html = '';
  try {
    html = await deps.fetchRaw(url, { userAgent: 'facebookexternalhit/1.1' });
  } catch {
    html = '';
  }
  const title = metaContent(html, 'og:title') ?? item.title ?? '';
  const show = (metaContent(html, 'og:description') ?? '').split('·')[0]?.trim() ?? '';
  const dur = Number(metaContent(html, 'music:duration') ?? '');
  const mins = Number.isFinite(dur) && dur > 0 ? dur / 60 : null;
  if (!title) throw new BandejaError('no pude leer la ficha del episodio');
  const reasons: string[] = [];
  // (a) La misma entrega subida a YouTube.
  const yt = await searchYoutube(deps, `${show} ${title}`.trim(), title);
  if (yt) {
    try {
      const c = await videoContent({ ...item, kind: 'youtube' }, deps, signal, yt);
      if (c.extra.basis === 'transcripcion')
        return {
          ...c,
          title,
          costMin: mins ?? c.costMin,
          costLabel: mins ? `🎧 ${minutesLabel(mins)}` : c.costLabel,
          extra: { ...c.extra, source: show ? `${show} (podcast)` : 'podcast', altUrl: yt },
          describe: `Episodio del podcast ${show || '?'} «${title}», con la transcripción de su versión en YouTube.`,
        };
      reasons.push('en YouTube no tiene transcripción');
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  } else reasons.push('no está en YouTube');
  // (b) El mp3 del RSS del programa (iTunes da el feed), transcrito en el PC.
  const mp3 = show ? await rssEnclosure(deps, show, title) : null;
  if (mp3) {
    const v = await safeVideoText(deps, mp3, { signal, directAudio: true });
    if (v.ok)
      return {
        title,
        text: v.text,
        costMin: mins,
        costLabel: mins ? `🎧 ${minutesLabel(mins)}` : '🎧 episodio',
        extra: { source: `${show} (podcast)`, basis: 'transcripcion' },
        describe: `Episodio del podcast ${show} «${title}», con la transcripción de su audio.`,
      };
    reasons.push(`el audio del RSS no se pudo transcribir (${v.reason})`);
  } else reasons.push('no encontré el RSS');
  return {
    title,
    text: `Ficha del episodio (sin transcripción): «${title}» del programa ${show || '?'}.`,
    costMin: mins,
    costLabel: mins ? `🎧 ${minutesLabel(mins)}` : '🎧 episodio',
    extra: {
      source: show ? `${show} (podcast)` : 'podcast',
      basis: 'ficha',
      basisReason: reasons.join('; '),
    },
    describe: `Episodio de podcast en Spotify. OJO: no hay transcripción (${reasons.join('; ')}); solo tienes el título y el programa: sé muy prudente con la nota y dilo en el MOTIVO.`,
  };
}

/** El enlace del mp3 de un episodio en el RSS del programa (búsqueda pública de iTunes). */
export async function rssEnclosure(
  deps: ProcesarDeps,
  show: string,
  title: string,
): Promise<string | null> {
  try {
    const found = JSON.parse(
      await deps.fetchRaw(
        `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=3&term=${encodeURIComponent(show)}`,
      ),
    ) as { results?: Array<{ collectionName?: string; feedUrl?: string }> };
    const feed = found.results?.find(
      (r) => r.feedUrl && titleOverlap(show, r.collectionName ?? '') >= 0.6,
    )?.feedUrl;
    if (!feed) return null;
    return enclosureFor(await deps.fetchRaw(feed), title);
  } catch {
    return null;
  }
}

/** En un RSS, el enclosure del <item> cuyo título se parece más (≥ 60 %). */
export function enclosureFor(rss: string, title: string): string | null {
  let best: { url: string; score: number } | null = null;
  for (const m of rss.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(block)?.[1] ?? '';
    const enc = /<enclosure[^>]+url=["']([^"']+)["']/i.exec(block)?.[1];
    if (!enc) continue;
    const score = titleOverlap(title, decodeEntities(t));
    if (score >= 0.6 && (!best || score > best.score)) best = { url: decodeEntities(enc), score };
  }
  return best?.url ?? null;
}

async function linkContent(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<Content> {
  const url = item.url ?? '';
  const host = hostOf(url);
  if (/(^|\.)spotify\.com$/.test(host) && /\/episode\//.test(url))
    return podcastContent(item, deps, signal);
  let html: string;
  try {
    html = await deps.fetchRaw(url);
  } catch (err) {
    throw new BandejaError(
      `no pude abrir la página (${String(err instanceof Error ? err.message : err).slice(0, 120)})`,
    );
  }
  const title = pageTitle(html);
  const description = metaContent(html, 'og:description') ?? metaContent(html, 'description');
  const isHtml = /<html|<body|<head|<meta/i.test(html.slice(0, 5000));
  const body = isHtml ? await extractText(await extractMainContent(html), 'text') : html;
  const text = [description ? `Descripción: ${description}` : '', body]
    .filter(Boolean)
    .join('\n\n');
  const w = words(body);
  const mins = readingMinutes(w);
  if (w < 40 && !description)
    throw new BandejaError('la página no tiene texto que leer (¿pide sesión?)');
  const thin = w < 200;
  const pdfUrl = originalPdfUrl(url, html);
  return {
    title,
    text,
    costMin: mins,
    costLabel: `📰 ~${minutesLabel(mins)} de lectura`,
    extra: {
      source: host,
      basis: thin ? 'descripcion' : 'texto',
      ...(thin ? { basisReason: 'la página trae muy poco texto (¿muro de pago o portada?)' } : {}),
      ...(pdfUrl ? { pdfUrl } : {}),
    },
    describe: `Artículo o página de ${host}${thin ? ' (muy poco texto: quizá solo la portada o un muro de pago; sé prudente y dilo en el MOTIVO)' : ''}.`,
  };
}

async function pdfContent(item: BandejaItem, deps: ProcesarDeps): Promise<Content> {
  if (!item.fileId || !deps.download || !deps.pdfText)
    throw new BandejaError('no puedo leer PDFs desde aquí');
  const bytes = await deps.download(item.fileId);
  if (!bytes) throw new BandejaError('no pude descargar el PDF de Telegram (¿más de 20 MB?)');
  const raw = await deps.pdfText(bytes);
  const pages = raw ? raw.split('\n\n').length : 0;
  const w = words(raw);
  if (w < 30) throw new BandejaError('el PDF no tiene texto (parece escaneado)');
  const mins = readingMinutes(w);
  return {
    title:
      item.fileName
        ?.replace(/\.pdf$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim() || null,
    text: raw,
    costMin: mins,
    costLabel: `📄 ${pages} págs · ~${minutesLabel(mins)}`,
    extra: { source: 'PDF', pages, basis: 'texto' },
    describe: `PDF «${item.fileName ?? 'sin nombre'}» de ${pages} páginas${raw.length > MAX_CONTENT_CHARS ? ' (te paso el principio y el final)' : ''}.`,
  };
}

/** ¿Un documento que sé leer además del PDF? EPUB (un libro), DOCX u ODT. */
export function readableDocKind(
  item: Pick<BandejaItem, 'mimeType' | 'fileName'>,
): 'epub' | 'docx' | 'odt' | null {
  const k = officeKind(item.mimeType ?? undefined, item.fileName ?? undefined);
  return k === 'epub' || k === 'docx' || k === 'odt' ? k : null;
}

/** EPUB / DOCX / ODT que mandó Nico: su texto entero, como un PDF. */
async function docContent(item: BandejaItem, deps: ProcesarDeps): Promise<Content> {
  const kind = readableDocKind(item);
  if (!item.fileId || !kind || !deps.download || !deps.docText)
    throw new BandejaError('no puedo leer ese documento desde aquí');
  const bytes = await deps.download(item.fileId);
  if (!bytes) throw new BandejaError('no pude descargar el documento de Telegram (¿más de 20 MB?)');
  let raw: string;
  try {
    raw = await deps.docText(bytes, item.mimeType ?? undefined, item.fileName ?? undefined);
  } catch (err) {
    throw new BandejaError(
      `no pude leer el ${kind.toUpperCase()} (${String(err instanceof Error ? err.message : err).slice(0, 100)})`,
    );
  }
  const w = words(raw);
  if (w < 30) throw new BandejaError(`el ${kind.toUpperCase()} no tiene texto que leer`);
  const mins = readingMinutes(w);
  const pages = Math.max(1, Math.round(w / WORDS_PER_BOOK_PAGE));
  const label = kind === 'epub' ? 'EPUB' : kind === 'docx' ? 'Word' : 'ODT';
  return {
    title:
      item.fileName
        ?.replace(/\.(epub|docx|odt)$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim() || null,
    text: raw,
    costMin: mins,
    costLabel: `${kind === 'epub' ? '📘' : '📝'} ~${pages} págs · ~${minutesLabel(mins)}`,
    extra: { source: label, pages, basis: 'texto' },
    describe: `${kind === 'epub' ? 'Libro en EPUB' : 'Documento'} «${item.fileName ?? 'sin nombre'}» de unas ${pages} páginas${raw.length > MAX_CONTENT_CHARS ? ' (te paso el principio y el final)' : ''}.`,
  };
}

const SPLIT_PROMPT = [
  'Miras una captura de pantalla que Nico guardó.',
  'Si es una LISTA de varias cosas guardadas (un chat consigo mismo con tarjetas de YouTube, posts de X, artículos…), contesta una línea por cosa, en este formato:',
  'ENLACE: <url completa, solo si se lee entera>',
  'VIDEO: <título exacto> | <canal>',
  'POST: @<usuario> | <texto del post>',
  'ARTICULO: <título> | <sitio>',
  'Si es UNA sola pieza (un post, un artículo, una gráfica), contesta solo: UNA',
  'No inventes nada que no se lea en la imagen.',
].join('\n');

/** Lee la respuesta de «qué hay en la captura»: null si es una sola pieza. */
export function parseSplit(reply: string): CaptureCandidate[] | null {
  if (/^\s*UNA\s*$/im.test(reply) && !/^(ENLACE|VIDEO|POST|ARTICULO):/im.test(reply)) return null;
  const out: CaptureCandidate[] = [];
  for (const line of reply.split('\n')) {
    const m = /^\s*[-•*]?\s*(ENLACE|VIDEO|POST|ARTICULO|ARTÍCULO)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const kind = (m[1] ?? '').toUpperCase();
    const val = (m[2] ?? '').trim();
    const [first, second] = val.split('|').map((x) => x.trim());
    if (kind === 'ENLACE') {
      const url = extractUrls(val)[0];
      if (url) out.push({ kind: kindOfUrl(url), url });
    } else if (kind === 'VIDEO' && first)
      out.push({ kind: 'youtube', title: first, ...(second ? { note: second } : {}) });
    else if (kind === 'POST' && first)
      out.push({
        kind: 'texto',
        title: `Post de ${first}`,
        note: `Post de X de ${first}: ${second ?? ''}`.trim(),
      });
    else if (first)
      out.push({
        kind: 'texto',
        title: first,
        note: `Artículo «${first}»${second ? ` de ${second}` : ''} ${SEEN_IN_CAPTURE}`,
      });
  }
  return out.length >= 1 ? out.slice(0, 15) : null;
}

async function imageContent(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<Content> {
  if (!item.fileId || !deps.download) throw new BandejaError('no puedo leer fotos desde aquí');
  const bytes = await deps.download(item.fileId);
  if (!bytes) throw new BandejaError('no pude descargar la foto de Telegram');
  const images = [
    {
      type: 'image' as const,
      mimeType: item.mimeType || 'image/jpeg',
      data: bytes.toString('base64'),
    },
  ];
  // ¿Una captura con varias cosas guardadas? Se parte en una por cosa.
  if (deps.addChild) {
    const complete = await deps.complete().catch(() => undefined);
    if (complete) {
      const split = parseSplit(
        await complete(SPLIT_PROMPT, 'La captura va adjunta.', { maxTokens: 800, signal, images }),
      );
      if (split && (split.length > 1 || split[0]?.url || split[0]?.kind === 'youtube')) {
        const children: number[] = [];
        let dups = 0;
        for (const c of split) {
          const r = deps.addChild(item, c);
          if (!r) continue;
          if (r.dup) dups++;
          else children.push(r.item.id);
        }
        throw new BandejaSplit(children, dups);
      }
    }
  }
  return {
    title: null,
    text: 'Lee el contenido de la captura adjunta (un post, un tuit, un artículo, una gráfica…) y juzga eso.',
    costMin: 1,
    costLabel: '🖼️ 1 min',
    extra: { source: 'captura', basis: 'captura' },
    describe: 'Captura de pantalla o foto que Nico guardó.',
    images,
  };
}

async function bookContent(item: BandejaItem, deps: ProcesarDeps): Promise<Content> {
  const isGrUrl = item.url ? /goodreads\.com\/book\/show\//.test(item.url) : false;
  const query =
    item.title ??
    (item.url
      ? decodeURIComponent(item.url.split('/').pop() ?? '')
          .replace(/^\d+[-.]?/, '')
          .replace(/[-_]+/g, ' ')
      : '');
  if (!query.trim() && !isGrUrl) throw new BandejaError('no sé qué libro es');
  const [gr, ol] = await Promise.all([
    goodreadsLookup(deps.fetchRaw, query, isGrUrl ? (item.url ?? undefined) : undefined),
    openLibraryLookup(deps.fetchRaw, olQuery(query)),
  ]);
  // El título que escribió Nico manda sobre el de Open Library (que suele venir en inglés).
  const title = gr.ok && gr.title ? gr.title : (item.title ?? ol?.title ?? query);
  const author = (gr.ok && gr.author) || ol?.author;
  const pages = ol?.pages;
  const mins = pages ? (pages * WORDS_PER_BOOK_PAGE) / WORDS_PER_MIN : null;
  const goodreads: Goodreads = {
    ok: gr.ok,
    ...(gr.rating !== undefined ? { rating: gr.rating } : {}),
    ...(gr.ratings !== undefined ? { ratings: gr.ratings } : {}),
    ...(gr.url ? { url: gr.url } : {}),
    ...(gr.reason ? { reason: gr.reason } : {}),
  };
  const lines = [
    `Libro: «${title}»${author ? ` de ${author}` : ''}${ol?.year ? ` (${ol.year})` : ''}${pages ? `, ${pages} páginas` : ''}.`,
    goodreads.ok && goodreads.rating !== undefined
      ? `Goodreads: ${goodreads.rating}/5 con ${goodreads.ratings ?? 0} valoraciones.`
      : `Goodreads: sin nota (${goodreads.reason ?? 'no encontrado'}).`,
    ol?.description
      ? `Descripción (Open Library): ${ol.description}`
      : 'Sin descripción disponible.',
    item.note ? `Nota de Nico: ${item.note}` : '',
    'Puedes usar lo que sepas de este libro si lo conoces bien; si no lo conoces, dilo en el MOTIVO y no inventes su contenido.',
  ].filter(Boolean);
  return {
    title,
    text: lines.join('\n'),
    costMin: mins,
    costLabel: pages && mins ? `📚 ${pages} págs · ~${minutesLabel(mins)}` : '📚 libro',
    extra: {
      ...(author ? { author } : {}),
      source: 'Libro',
      goodreads,
      basis: ol?.description ? 'ficha' : 'ficha',
      ...(pages ? { pages } : {}),
      ...(ol?.year ? { year: ol.year } : {}),
      ...(ol?.url ? { altUrl: ol.url } : {}),
      ...(ol?.rating && ol.ratings
        ? {
            publicRating: `⭐ Open Library ${ol.rating.toFixed(2).replace('.', ',')}/5 (${ol.ratings} valoraciones)`,
          }
        : {}),
    },
    describe: 'Un libro que Nico apuntó para leer.',
  };
}

/** Lo que se busca en Open Library: sin «(Saga, #1)» ni subtítulos largos. */
function olQuery(q: string): string {
  return q
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Marca de las cosas que solo se vieron por su título en una captura (ver parseSplit). */
export const SEEN_IN_CAPTURE = '(visto en una captura)';

function textContent(item: BandejaItem): Content {
  const text = item.note ?? item.title ?? '';
  if (!text.trim()) throw new BandejaError('no hay texto que mirar');
  const mins = readingMinutes(words(text));
  // Un artículo o PDF del que la captura solo enseña el título: nota provisional.
  const onlyTitle = text.includes(SEEN_IN_CAPTURE);
  return {
    title: item.title,
    text,
    costMin: onlyTitle ? null : mins,
    costLabel: onlyTitle ? '📝 sin abrir' : `📝 ${minutesLabel(mins)}`,
    extra: onlyTitle
      ? {
          source: 'captura',
          basis: 'ficha',
          basisReason: 'en la captura solo se ve el título; mándame el enlace o el archivo',
        }
      : { source: 'nota', basis: 'texto' },
    describe: 'Un texto o idea que Nico guardó (puede ser solo lo que se leía en una captura).',
  };
}

async function contentFor(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<Content> {
  const kind: BandejaKind = item.kind;
  if (kind === 'youtube') return videoContent(item, deps, signal);
  if (kind === 'x') return xContent(item, deps, signal);
  if (kind === 'pdf' && item.fileId) return pdfContent(item, deps);
  if (kind === 'imagen') return imageContent(item, deps, signal);
  if (kind === 'libro') return bookContent(item, deps);
  if (kind === 'texto' && !item.url) {
    if (item.fileId) {
      if (readableDocKind(item)) return docContent(item, deps);
      throw new BandejaError('ese tipo de documento no lo sé leer aún (PDF, EPUB, DOCX u ODT sí)');
    }
    return textContent(item);
  }
  return linkContent(item, deps, signal);
}

/** Procesa una cosa y devuelve su resultado (lanza BandejaError con el motivo en español). */
export async function processItem(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<ProcessResult & { url?: string }> {
  const content = await contentFor(item, deps, signal);
  const complete = await deps.complete().catch(() => undefined);
  if (!complete) throw new BandejaError('no tengo modelo para juzgarlo ahora mismo');
  const temas = deps.temas?.() ?? [];
  const head = [
    content.describe,
    content.costLabel ? `Coste de verlo/leerlo entero: ${content.costLabel}.` : '',
    content.title ? `Título: ${content.title}` : '',
    (content.url ?? item.url) ? `Enlace: ${content.url ?? item.url}` : '',
  ].filter(Boolean);
  const user = `${head.join('\n')}\n\n<contenido>\n${cap(content.text)}\n</contenido>`;
  let reply: string;
  try {
    reply = await complete(verdictPrompt(temas), user, {
      maxTokens: 900,
      signal,
      ...(content.images ? { images: content.images } : {}),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new BandejaError(
      `el modelo no contestó (${String(err instanceof Error ? err.message : err).slice(0, 100)})`,
    );
  }
  const parsed = parseVerdict(reply, temas);
  if (!parsed) throw new BandejaError('el modelo no dio un veredicto claro');
  const tags = [
    ...new Set([
      ...parsed.tags,
      ...directTags(temas, `${content.title ?? ''}\n${content.text.slice(0, 5000)}`),
    ]),
  ].slice(0, 4);
  return {
    title: content.title ?? parsed.title,
    verdict: parsed.verdict,
    score: parsed.score,
    reason: parsed.reason || null,
    ideas: parsed.ideas,
    costMin: content.costMin,
    costLabel: content.costLabel,
    extra: { ...content.extra, ...(tags.length ? { tags } : {}) },
    ...(content.url ? { url: content.url } : {}),
    ...(keepsBody(item, content) ? { body: content.text } : {}),
  };
}

/**
 * ¿Se guarda el texto entero para «📖 Al Kindle»? Solo lo que se leyó de verdad (la
 * transcripción, el post, el artículo); no una descripción, ni el PDF (va el original).
 */
function keepsBody(item: BandejaItem, content: Content): boolean {
  if (item.kind === 'pdf' || item.kind === 'imagen' || item.kind === 'libro') return false;
  return content.extra.basis === 'transcripcion' || content.extra.basis === 'texto';
}

/**
 * El texto entero de una cosa, con el mismo camino que el procesado (subtítulos o audio
 * transcrito, post de X, página…), para «📖 Al Kindle» cuando no estaba guardado. Lanza
 * BandejaError si solo hay una descripción o una ficha.
 */
export async function readableText(
  item: BandejaItem,
  deps: ProcesarDeps,
  signal?: AbortSignal,
): Promise<{ title: string | null; text: string; extra: BandejaExtra }> {
  const c = await contentFor(item, deps, signal);
  if (!keepsBody(item, c))
    throw new BandejaError(
      c.extra.basisReason
        ? `no tengo el texto entero (${c.extra.basisReason})`
        : 'no tengo el texto entero, solo la descripción',
    );
  return { title: c.title, text: c.text, extra: c.extra };
}

/**
 * Tope de tiempo por cosa. El whisper del PC tarda (en CPU, a menudo la mitad de lo que
 * dura el audio o más): con 15 min y «transcribe hasta 3 h», un podcast de 1 h acababa en
 * «tardaba demasiado» sin veredicto. Ahora la transcripción para a los 35 min con lo que
 * lleve y la cosa se juzga con eso; los 45 min son solo la red de seguridad.
 */
export const PROCESS_TIMEOUT_MS = 45 * 60_000;
/** Tope de la transcripción dentro de una cosa (deja margen para el modelo). */
export const TRANSCRIBE_BUDGET_MS = 35 * 60_000;

/**
 * Cola de procesado: de una en una, en segundo plano, sin reintentos. Al arrancar se
 * retoma lo que quedó a medias (`resume`).
 */
export class BandejaQueue {
  readonly #store: BandejaStore;
  readonly #deps: ProcesarDeps;
  readonly #queue: number[] = [];
  readonly #waiters = new Map<number, Array<() => void>>();
  #running = false;
  #current: number | null = null;
  readonly #idle: Array<() => void> = [];
  readonly #warn: (msg: string, data?: Record<string, unknown>) => void;

  constructor(
    store: BandejaStore,
    deps: ProcesarDeps,
    warn: (msg: string, data?: Record<string, unknown>) => void = () => {},
  ) {
    this.#store = store;
    this.#deps = deps;
    this.#warn = warn;
  }

  /**
   * Mete una cosa en la cola; la promesa se cumple cuando termina (bien o mal).
   * `first`: «⚡ Míralo ya» se pone delante de lo que espera (antes esperaba detrás de
   * cinco podcasts de 3 h); la que está en marcha no se corta.
   */
  enqueue(id: number, opts: { first?: boolean } = {}): Promise<void> {
    const done = new Promise<void>((resolve) => {
      const list = this.#waiters.get(id) ?? [];
      list.push(resolve);
      this.#waiters.set(id, list);
    });
    if (this.#current !== id) {
      const at = this.#queue.indexOf(id);
      if (opts.first) {
        if (at >= 0) this.#queue.splice(at, 1);
        this.#queue.unshift(id);
      } else if (at < 0) this.#queue.push(id);
    }
    void this.#pump();
    return done;
  }

  /** Lo que quedó sin procesar al cerrar el daemon. */
  resume(): number {
    const items = this.#store.unprocessed();
    for (const it of items) void this.enqueue(it.id);
    return items.length;
  }

  /** Se cumple cuando la cola se queda vacía (tests, y antes de cerrar). */
  idle(): Promise<void> {
    if (!this.#running && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  get size(): number {
    return this.#queue.length + (this.#running ? 1 : 0);
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length > 0) {
        const id = this.#queue.shift() as number;
        this.#current = id;
        await this.#runOne(id);
        this.#current = null;
        for (const w of this.#waiters.get(id) ?? []) w();
        this.#waiters.delete(id);
      }
    } finally {
      this.#running = false;
      for (const w of this.#idle.splice(0)) w();
    }
  }

  async #runOne(id: number): Promise<void> {
    let item = this.#store.get(id);
    if (!item || item.state === 'descartado') return;
    this.#store.setStatus(id, 'procesando');
    // Un vídeo que llegó solo por su título (de una captura): primero su enlace, y si ya
    // estaba guardado por él, fuera el repetido antes de gastar transcripción y modelo.
    if (!item.url && item.kind === 'youtube' && item.title) {
      const found = await searchYoutube(
        this.#deps,
        `${item.title} ${item.note ?? ''}`.trim(),
        item.title,
      );
      if (found) {
        this.#store.setUrl(id, found);
        const twin = this.#store.findPendingByKey(item.chatId, canonicalKey(found), id);
        if (twin) {
          this.#store.closeAs(id, `repetido de #${twin.id}`);
          return;
        }
        item = this.#store.get(id) ?? item;
      }
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROCESS_TIMEOUT_MS);
    timer.unref?.();
    try {
      const result = await Promise.race([
        processItem(item, this.#deps, ctl.signal),
        new Promise<never>((_, reject) => {
          ctl.signal.addEventListener('abort', () =>
            reject(
              new BandejaError(
                `tardaba demasiado (más de ${Math.round(PROCESS_TIMEOUT_MS / 60_000)} min)`,
              ),
            ),
          );
        }),
      ]);
      if (result.url && !item.url) {
        this.#store.setUrl(id, result.url);
        // El vídeo de una captura que ya estaba guardado por su enlace: fuera el repetido.
        const twin = this.#store.findPendingByKey(item.chatId, canonicalKey(result.url), id);
        if (twin) {
          this.#store.closeAs(id, `repetido de #${twin.id}`);
          return;
        }
      }
      this.#store.saveResult(id, result, (this.#deps.now ?? (() => new Date()))());
      if (result.body) this.#store.saveText(id, result.body);
      const done = this.#store.get(id);
      if (done && this.#deps.onDone) {
        // «/bandeja kindle auto on»: lo 🔴 se manda solo. Nunca frena la cola.
        void Promise.resolve()
          .then(() => this.#deps.onDone?.(done))
          .catch((err: unknown) =>
            this.#warn('bandeja: aviso de fin falló', { id, err: String(err) }),
          );
      }
    } catch (err) {
      if (err instanceof BandejaSplit) {
        const parts = err.children.map((c) => `#${c}`).join(', ');
        this.#store.closeAs(
          id,
          `era una lista: la separé en ${err.children.length} (${parts || 'ninguna nueva'})${err.dups ? `; ${err.dups} ya estaba${err.dups === 1 ? '' : 'n'} guardada${err.dups === 1 ? '' : 's'}` : ''}`,
        );
        for (const c of err.children) void this.enqueue(c);
        return;
      }
      const reason =
        err instanceof BandejaError
          ? err.message
          : `fallo inesperado (${String(err instanceof Error ? err.message : err).slice(0, 120)})`;
      if (!(err instanceof BandejaError))
        this.#warn('bandeja: fallo al procesar', { id, err: String(err) });
      this.#store.setStatus(id, 'error', reason);
    } finally {
      clearTimeout(timer);
    }
  }
}
