/**
 * La bandeja de entrada (Nico, 11 nov 2026): lo que se guarda a lo largo del día
 * (vídeos de YouTube, posts de X, PDFs, artículos, libros) para que por la noche
 * Asistenta le diga qué merece la pena de verdad.
 *
 * REGLA DE CAPTURA (sin secuestrar la conversación normal):
 * - Lo que llega «a secas», sin ninguna palabra tuya, va a la bandeja:
 *   · un mensaje que solo trae enlaces (uno o varios), también reenviado;
 *   · un PDF o un documento sin pie de texto;
 *   · una foto o captura sin pie de texto;
 *   · un reenvío de otro chat que trae un enlace, sin comentario tuyo.
 * - «libro: Título» (o «📚 Título») guarda un libro.
 * - /bandeja <enlace o texto> guarda a mano cualquier cosa; /bandeja libro <título>, un libro.
 * - Todo lo que lleve una pregunta o una frase tuya («resúmeme esto <enlace>», un PDF
 *   con «¿qué opinas?») sigue yendo a la conversación de siempre.
 * - No se captura: una respuesta a otro mensaje (contestar con un enlace a «pásame el
 *   enlace» es conversación), notas de voz, grupos ni nada que no sea del dueño en privado.
 * - /bandeja captura off apaga la captura automática (solo queda /bandeja y «libro:»).
 *
 * Aquí solo se decide QUÉ es; guardar y procesar van aparte (store.ts, procesar.ts).
 */
import { xVideoUrl } from '../media/resumen-video.js';
import { isYoutubeVideoUrl } from '../media/transcript.js';

export type BandejaKind = 'youtube' | 'x' | 'enlace' | 'pdf' | 'imagen' | 'libro' | 'texto';

export interface CaptureCandidate {
  kind: BandejaKind;
  url?: string;
  /** Título provisional (nombre del PDF, título del libro…) hasta que se procese. */
  title?: string;
  /** Texto que acompaña: el del reenvío o el que se guardó a mano. */
  note?: string;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
}

/** Lo mínimo de un mensaje entrante que mira la regla. */
export interface CaptureInput {
  text: string;
  photoFileId?: string;
  albumPhotoFileIds?: string[];
  /** El resto de documentos de un envío de varios a la vez (álbum de Telegram). */
  albumDocuments?: Array<{ fileId: string; mimeType?: string; name?: string }>;
  documentFileId?: string;
  documentMimeType?: string;
  documentName?: string;
  audioFileId?: string;
  replyToMessageId?: string;
  forwardedFrom?: string;
  /** Enlaces escondidos tras el texto (text_link de Telegram). */
  linkUrls?: string[];
  isGroup?: boolean;
}

/** Máximo de cosas que guarda un solo mensaje (una lista de 40 enlaces no es un día normal). */
export const MAX_PER_MESSAGE = 10;

const URL_RE = /https?:\/\/[^\s<>"«»]+/gi;
/** La marca que pone el adaptador de Telegram tras un reenvío con comentario tuyo. */
const OWN_COMMENT_MARK = '[Fin del mensaje reenviado';
const FORWARD_MARK = /^\[Mensaje reenviado(?: de [^\]\n]*)?\]\s*/;

/**
 * Quita la puntuación que se pega al final de un enlace pegado en una frase. Un «)» solo
 * se quita si no cierra un «(» del propio enlace: es.wikipedia.org/wiki/Mises_(economista)
 * perdía el paréntesis y daba una página que no existe.
 */
function cleanUrl(raw: string): string {
  let u = raw;
  for (;;) {
    const next = u.replace(/[,.;:!?»"'\]]+$/u, '');
    if (next.endsWith(')') && count(next, '(') < count(next, ')')) {
      u = next.slice(0, -1);
      continue;
    }
    return next;
  }
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = cleanUrl(m[0]);
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
    } catch {
      continue;
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Qué tipo de cosa es un enlace. */
export function kindOfUrl(url: string): BandejaKind {
  if (isYoutubeVideoUrl(url)) return 'youtube';
  if (xVideoUrl(url)) return 'x';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'enlace';
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host.endsWith('goodreads.com') && /^\/book\/show\//.test(parsed.pathname)) return 'libro';
  if (host === 'openlibrary.org' && /^\/(works|books)\//.test(parsed.pathname)) return 'libro';
  if (/\.pdf$/i.test(parsed.pathname)) return 'pdf';
  return 'enlace';
}

const TRACKING = /^(utm_\w+|si|s|t|is|a|ref|ref_src|feature|fbclid|gclid|igsh|mc_\w+|pp)$/i;

/**
 * Clave para no guardar dos veces lo mismo: el id del vídeo de YouTube (watch, youtu.be,
 * shorts…), el id del post de X, o la URL sin parámetros de seguimiento (si=, is=,
 * utm_…) ni #ancla. Nico guarda el mismo vídeo con youtu.be y con watch?v=.
 */
export function canonicalKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url.trim();
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, '');
  if (isYoutubeVideoUrl(url)) {
    const id =
      host === 'youtu.be'
        ? u.pathname.slice(1).split('/')[0]
        : (u.searchParams.get('v') ?? u.pathname.split('/')[2]);
    if (id) return `yt:${id}`;
  }
  const x = xVideoUrl(url);
  if (x) return `x:${x.split('/').pop()}`;
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  params.sort(([a], [b]) => a.localeCompare(b));
  const q = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${u.pathname.replace(/\/+$/, '')}${q}`;
}

/** Lo que sobra al enseñar un enlace en cualquier sitio: rastreo puro. */
const SHOWN_TRACKING =
  /^(utm_\w+|fbclid|gclid|dclid|msclkid|igsh|igshid|mc_cid|mc_eid|_hsenc|_hsmi|si)$/i;
/** Y lo que sobra según el sitio (en otro sitio `s` o `a` pueden ser la búsqueda o la página). */
const SHOWN_TRACKING_BY_HOST: Array<[RegExp, RegExp]> = [
  [/(^|\.)(x|twitter)\.com$/, /^(s|t|a|ref_src|ref_url)$/i],
  [/(^|\.)(youtube\.com|youtu\.be)$/, /^(is|feature|pp|ab_channel)$/i],
  [/(^|\.)spotify\.com$/, /^(context|nd|dlsi)$/i],
  [/(^|\.)instagram\.com$/, /^(img_index)$/i],
];

/**
 * El enlace para enseñarlo: sin los parámetros de seguimiento que traen los «compartir»
 * (`?si=`, `?is=`, `utm_…`, y en X `?s=`, `?t=`, `?a=`). Se guarda tal cual llegó; solo
 * cambia lo que se ve. El minuto de un vídeo (`t=`) y todo lo demás se quedan.
 */
export function displayUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return url;
  }
  if (!u.search) return url;
  const host = u.hostname.toLowerCase();
  const extra = SHOWN_TRACKING_BY_HOST.filter(([h]) => h.test(host)).map(([, re]) => re);
  const keep = [...u.searchParams.entries()].filter(
    ([k]) => !SHOWN_TRACKING.test(k) && !extra.some((re) => re.test(k)),
  );
  if (keep.length === [...u.searchParams.keys()].length) return url;
  u.search = keep.length ? new URLSearchParams(keep).toString() : '';
  return u.toString();
}

/** El id de un vídeo de YouTube, o null. */
export function youtubeId(url: string): string | null {
  const k = canonicalKey(url);
  return k.startsWith('yt:') ? k.slice(3) : null;
}

const LIBRO_RE = /^\s*(?:libro\s*[:：-]|📚|📖)\s*(.+)$/is;

/** «libro: El nombre del viento» / «📚 Sapiens, Harari» → el título (o null). */
export function bookTitleFrom(text: string): string | null {
  const m = LIBRO_RE.exec(text.trim());
  const title = m?.[1]?.trim().replace(/\s+/g, ' ');
  if (!title || title.length < 2 || title.length > 200) return null;
  // «libro: ¿cuál me recomiendas?» es una pregunta, no un libro para la bandeja.
  if (/[?¿]/.test(title)) return null;
  return title;
}

function isPdfDoc(m: Pick<CaptureInput, 'documentMimeType' | 'documentName'>): boolean {
  const mime = m.documentMimeType?.toLowerCase() ?? '';
  return mime === 'application/pdf' || /\.pdf$/i.test(m.documentName?.trim() ?? '');
}

/** Texto propio del mensaje, sin la marca de reenvío. */
function ownText(m: CaptureInput): string {
  return m.text.replace(FORWARD_MARK, '').trim();
}

/**
 * ¿Va a la bandeja este mensaje por sí solo? Devuelve lo que hay que guardar, o
 * null para que siga a la conversación de siempre. `auto=false` (captura apagada)
 * solo deja pasar «libro: …».
 */
export function detectCapture(
  m: CaptureInput,
  opts: { auto?: boolean } = {},
): CaptureCandidate[] | null {
  if (m.isGroup) return null;
  if (m.audioFileId) return null;
  const text = ownText(m);
  // «libro: X» es explícito: vale aunque la captura automática esté apagada.
  if (!m.documentFileId && !m.photoFileId && !m.replyToMessageId) {
    const book = bookTitleFrom(text);
    if (book) return [{ kind: 'libro', title: book }];
  }
  if (opts.auto === false) return null;
  if (m.replyToMessageId) return null;
  // Un reenvío con comentario tuyo debajo: el comentario es para la conversación.
  if (m.text.includes(OWN_COMMENT_MARK)) return null;
  // El pie de un REENVÍO no es tuyo (el texto del post del canal): no lo saca de la bandeja.
  const othersCaption = m.forwardedFrom && text ? { note: text.slice(0, 2000) } : {};
  if (m.documentFileId) {
    if (text && !m.forwardedFrom) return null;
    // Varios PDFs de una vez llegan como un álbum: antes solo se guardaba el primero.
    const docs = [
      { fileId: m.documentFileId, mimeType: m.documentMimeType, name: m.documentName },
      ...(m.albumDocuments ?? []),
    ];
    return docs.slice(0, MAX_PER_MESSAGE).map((d) => ({
      kind: isPdfDoc({ documentMimeType: d.mimeType, documentName: d.name }) ? 'pdf' : 'texto',
      title: d.name?.trim() || undefined,
      fileId: d.fileId,
      fileName: d.name?.trim() || undefined,
      mimeType: d.mimeType,
      ...othersCaption,
    }));
  }
  const urls = extractUrls(text);
  for (const u of m.linkUrls ?? []) if (!urls.includes(u)) urls.push(u);
  if (m.photoFileId) {
    if (text && !m.forwardedFrom) return null;
    // Un post reenviado con foto y enlace: lo que vale es el enlace (la foto es su portada).
    if (m.forwardedFrom && urls.length)
      return urls.slice(0, MAX_PER_MESSAGE).map((url) => ({
        kind: kindOfUrl(url),
        url,
        ...othersCaption,
      }));
    // Varias capturas de una vez (álbum): una cosa por captura; antes solo la primera.
    return [m.photoFileId, ...(m.albumPhotoFileIds ?? [])]
      .slice(0, MAX_PER_MESSAGE)
      .map((fileId) => ({
        kind: 'imagen' as const,
        fileId,
        mimeType: 'image/jpeg',
        ...othersCaption,
      }));
  }
  if (urls.length === 0) return null;
  let rest = text;
  for (const u of urls) rest = rest.split(u).join(' ');
  const leftover = rest.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (leftover && !m.forwardedFrom) return null;
  // Reenviado: el texto del otro va como nota del enlace (un tuit reenviado desde un canal).
  const note = m.forwardedFrom && leftover ? text.slice(0, 2000) : undefined;
  return urls.slice(0, MAX_PER_MESSAGE).map((url) => ({
    kind: kindOfUrl(url),
    url,
    ...(note ? { note } : {}),
  }));
}

/** Cuánto vale «te lo acabo de pedir»: pasado esto, una captura a secas va a la bandeja. */
export const PIDIO_ADJUNTO_MS = 15 * 60_000;
// Petición (imperativo o «¿me mandas…?»), no «te he mandado»: el asistente diciendo que ya
// lo envió no espera nada.
const PIDE_VERBO =
  /\b(m[aá]nd(a|ame|amela|amelo|as|arme|[aá]rmela|[aá]rmelo)|env[ií](a|ame|amela|amelo|as|arme)|p[aá]s(a|ame|amela|amelo|as|arme)|s[uú]b(e|eme|es|ir|irme)|adjunt(a|ame|as|ar)|compart(e|eme|es|ir|irme)|p[eé]g(a|ame|as)|reenv[ií](a|ame|as))\b/i;
const PIDE_COSA =
  /\b(fotos?|capturas?|pantallazos?|im[aá]gen(es)?|pdfs?|archivos?|ficheros?|documentos?|enlaces?|links?|urls?|tickets?|facturas?)\b/i;

/**
 * ¿El asistente acaba de pedir un archivo, una foto o un enlace? («Mándame una captura del
 * error», «pásame el PDF y lo reviso».) Entonces lo que llega a secas es la respuesta, no
 * algo para la bandeja: antes la captura del error acababa «📥 guardada» y la conversación
 * se quedaba esperando.
 */
export function pidioAdjunto(
  last: { text: string; at: number } | null | undefined,
  now: number,
): boolean {
  if (!last?.text || now - last.at > PIDIO_ADJUNTO_MS || now < last.at - 60_000) return false;
  // Solo el cierre del mensaje (las dos últimas frases): si pidió algo y luego siguió con
  // otra cosa, el hilo no se quedó esperando ese archivo (bugs-35). Antes bastaba con que
  // saliera en los últimos 400 caracteres.
  const frases = last.text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(-2);
  return frases.some(
    (f) => PIDE_VERBO.test(f) && PIDE_COSA.test(f) && !EXPLICA.test(f) && !SI_MANDAS.test(f),
  );
}

// Explicar la bandeja («mándame enlaces y te los guardo en la bandeja») no es pedir un
// archivo para esta conversación; y «si me mandas un enlace, lo guardo» describe, no pide.
const EXPLICA = /\bbandeja\b/i;
const SI_MANDAS =
  /\bsi\s+(me\s+|le\s+|nos\s+)?(m[aá]nd|env[ií]|p[aá]s|s[uú]b|adjunt|compart|p[eé]g|reenv)\w*/i;

/**
 * La última respuesta del asistente en un hilo, solo si el turno terminó en ella (el hilo
 * espera a Nico). Un turno a medias (iba a usar una herramienta), cortado o con error no
 * espera nada; y si lo último es de Nico o de una herramienta, tampoco.
 */
export function ultimaRespuesta(messages: readonly unknown[]): { text: string; at: number } | null {
  const last = messages.at(-1) as
    | { role?: string; content?: unknown; timestamp?: number; stopReason?: string }
    | undefined;
  if (last?.role !== 'assistant' || typeof last.timestamp !== 'number') return null;
  if (last.stopReason !== undefined && last.stopReason !== 'stop') return null;
  const text = Array.isArray(last.content)
    ? last.content
        .map((b: { type?: string; text?: string }) => (b?.type === 'text' ? (b.text ?? '') : ''))
        .join('')
    : typeof last.content === 'string'
      ? last.content
      : '';
  return text ? { text, at: last.timestamp } : null;
}

/** «/bandeja <cosa>» a mano: enlaces, «libro X» o un texto/idea suelto. */
export function explicitCapture(args: string): CaptureCandidate[] | null {
  const t = args.trim();
  if (!t) return null;
  const libro = /^libro\s+(.+)$/is.exec(t)?.[1]?.trim();
  if (libro) return [{ kind: 'libro', title: libro.replace(/\s+/g, ' ').slice(0, 200) }];
  const asBook = bookTitleFrom(t);
  if (asBook) return [{ kind: 'libro', title: asBook }];
  const urls = extractUrls(t);
  if (urls.length > 0) {
    let rest = t;
    for (const u of urls) rest = rest.split(u).join(' ');
    const note = rest.replace(/\s+/g, ' ').trim();
    return urls.slice(0, MAX_PER_MESSAGE).map((url) => ({
      kind: kindOfUrl(url),
      url,
      ...(note ? { note: note.slice(0, 2000) } : {}),
    }));
  }
  return [{ kind: 'texto', title: t.slice(0, 80), note: t.slice(0, 4000) }];
}
