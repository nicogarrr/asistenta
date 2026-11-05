/**
 * «Tus temas»: lo que ha pasado durante la noche con lo que Nico sigue (el Sporting, un
 * producto, su sector), en tarjetas cortas con su fuente dentro del resumen de la mañana.
 * Como ChatGPT Pulse (https://openai.com/index/introducing-chatgpt-pulse/), pero sin gastar
 * tokens: titulares de las últimas horas de Google Noticias (RSS público, en español),
 * sin repetir los que ya vio.
 *
 * Los temas son los que él pide («sígueme el tema de la F1») y el equipo que tiene apuntado
 * («Soy del Sporting»). Antes el resumen no tenía ninguna sección de noticias.
 */
import { readFileSync } from 'node:fs';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from './core/lazy-schema.js';
import { writeFileReplacing } from './fs-tmp.js';
import { log } from './log.js';
import { foldAccents } from './text.js';

export const MAX_TEMAS = 5;
/** Temas que se miran cada mañana (los primeros de la lista). */
export const TEMAS_POR_RESUMEN = 3;
export const TARJETAS_POR_TEMA = 2;
/** Solo titulares de este rato hacia atrás («lo de esta noche»). */
export const VENTANA_NOTICIAS_MS = 30 * 3_600_000;
/** Cuántos titulares ya vistos se recuerdan (para no repetirlos otro día). */
const MAX_VISTOS = 300;

export interface Tarjeta {
  tema: string;
  titulo: string;
  fuente?: string;
  url: string;
  at?: number;
}

interface TemasFile {
  temas: string[];
  vistos: string[];
}

/** Los temas que sigue y los titulares que ya se le enseñaron, en un JSON. */
export class TemasStore {
  readonly #file: string | undefined;
  #data: TemasFile;

  constructor(file?: string) {
    this.#file = file;
    this.#data = { temas: [], vistos: [] };
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TemasFile>;
      this.#data = {
        temas: Array.isArray(raw.temas) ? raw.temas.filter((t) => typeof t === 'string') : [],
        vistos: Array.isArray(raw.vistos) ? raw.vistos.filter((t) => typeof t === 'string') : [],
      };
    } catch {
      // sin fichero todavía
    }
  }

  list(): string[] {
    return [...this.#data.temas];
  }

  /** Añade un tema; devuelve un error en llano o null. */
  add(tema: string): string | null {
    const t = tema
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.!]+$/, '');
    if (t.length < 2) return 'Dime qué tema.';
    if (t.length > 60) return 'Dímelo más corto (60 caracteres como mucho).';
    if (this.#data.temas.some((x) => foldAccents(x) === foldAccents(t))) return null;
    if (this.#data.temas.length >= MAX_TEMAS)
      return `Ya sigo ${MAX_TEMAS} temas: quita alguno antes.`;
    this.#data.temas.push(t);
    this.#save();
    return null;
  }

  /** Quita los que casan con `needle`; devuelve los quitados. */
  remove(needle: string): string[] {
    const want = foldAccents(needle).trim();
    if (!want) return [];
    const gone = this.#data.temas.filter((t) => foldAccents(t).includes(want));
    this.#data.temas = this.#data.temas.filter((t) => !gone.includes(t));
    if (gone.length) this.#save();
    return gone;
  }

  seen(url: string): boolean {
    return this.#data.vistos.includes(url);
  }

  markSeen(urls: readonly string[]): void {
    const fresh = urls.filter((u) => !this.#data.vistos.includes(u));
    if (!fresh.length) return;
    this.#data.vistos = [...this.#data.vistos, ...fresh].slice(-MAX_VISTOS);
    this.#save();
  }

  #save(): void {
    if (!this.#file) return;
    try {
      writeFileReplacing(this.#file, JSON.stringify(this.#data));
    } catch (err) {
      log.warn('temas save failed', { err: String(err) });
    }
  }
}

/** «Soy del Sporting», «soy del Real Madrid» apuntados → su equipo es un tema. */
export function temasDelPerfil(entries: readonly string[]): string[] {
  const out: string[] = [];
  const add = (tema: string | undefined) => {
    const t = tema?.replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2) return;
    if (!out.some((x) => foldAccents(x).toLowerCase() === foldAccents(t).toLowerCase()))
      out.push(t);
  };
  for (const e of entries) {
    const body = e
      .replace(/^\[(?:auto|dicho|importado)\]\s*/i, '')
      .trim()
      .replace(/[.!]+$/u, '');
    // Su equipo: «Soy del Sporting» (con mayúscula: «soy de Gijón» no es un equipo).
    const team = /^soy (?:del|de la|hincha del|socio del|aficionad[oa] del)\s+(.{2,40})$/iu.exec(
      body,
    )?.[1];
    if (team && /^\p{Lu}/u.test(team.trim())) {
      add(team);
      continue;
    }
    // Lo que sigue: «sigo la F1», «sigo mucho el ciclismo», «soy fan de Rosalía», «soy muy
    // aficionado al ciclismo», «me encanta la Fórmula 1». Solo frases cortas y de afición:
    // «me gusta la pizza» no trae titulares.
    const sigue =
      /^(?:sigo(?: mucho| siempre)?|soy (?:muy )?(?:fan|fanatic[oa]|seguidor[a]?) de|soy (?:muy )?aficionad[oa] (?:a|al|a la|de)|me encanta(?:n)?)\s+(?:(?:el|la|los|las)\s+)?(.{2,30})$/iu.exec(
        body,
      )?.[1];
    if (sigue && !/\b(?:comer|dormir|leer|cocinar|pizza|chocolate|caf[eé]|series?)\b/iu.test(sigue))
      add(sigue.replace(/^(?:a|el|la|los|las)\s+/iu, ''));
  }
  return out;
}

/** La búsqueda de Google Noticias en español de las últimas 24 h, como RSS. */
export function noticiasUrl(tema: string): string {
  const q = encodeURIComponent(`${tema} when:1d`);
  return `https://news.google.com/rss/search?q=${q}&hl=es&gl=ES&ceid=ES:es`;
}

const decode = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Los <item> de un RSS: título (sin « - Fuente» del final), enlace, fuente y fecha. */
export function parseRss(xml: string): Array<Omit<Tarjeta, 'tema'>> {
  const out: Array<Omit<Tarjeta, 'tema'>> = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1] ?? '';
    const tag = (name: string): string =>
      decode(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(item)?.[1] ?? '');
    const url = tag('link');
    let titulo = tag('title');
    const fuente = tag('source') || undefined;
    if (fuente && titulo.endsWith(` - ${fuente}`)) titulo = titulo.slice(0, -(fuente.length + 3));
    const at = Date.parse(tag('pubDate'));
    if (!titulo || !/^https?:\/\//.test(url)) continue;
    out.push({ titulo, url, fuente, at: Number.isFinite(at) ? at : undefined });
  }
  return out;
}

/**
 * Las tarjetas de la mañana: por tema, los titulares recientes que aún no vio (como mucho
 * TARJETAS_POR_TEMA), sin el mismo titular dos veces. Un tema que falla se salta.
 */
export async function tarjetasDeTemas(
  temas: readonly string[],
  fetchText: (url: string) => Promise<string>,
  store: Pick<TemasStore, 'seen'>,
  now: number,
): Promise<Tarjeta[]> {
  const out: Tarjeta[] = [];
  const titles = new Set<string>();
  const lists = await Promise.all(
    temas.slice(0, TEMAS_POR_RESUMEN).map(async (tema) => {
      try {
        return { tema, items: parseRss(await fetchText(noticiasUrl(tema))) };
      } catch (err) {
        log.warn('temas: noticias no disponibles', { tema, err: String(err) });
        return { tema, items: [] };
      }
    }),
  );
  for (const { tema, items } of lists) {
    let n = 0;
    for (const it of items) {
      if (n >= TARJETAS_POR_TEMA) break;
      if (it.at !== undefined && (now - it.at > VENTANA_NOTICIAS_MS || it.at > now + 3_600_000))
        continue;
      const key = foldAccents(it.titulo).replace(/\W+/g, ' ').trim();
      if (store.seen(it.url) || titles.has(key)) continue;
      titles.add(key);
      out.push({ tema, ...it });
      n++;
    }
  }
  return out;
}

/** Una tarjeta en una línea: «Sporting: El Sporting gana en Oviedo (El Comercio)». */
export function tarjetaLine(t: Tarjeta): string {
  const src = t.fuente ? ` (${t.fuente})` : '';
  return `${t.tema}: ${t.titulo}${src}`;
}

/** Las tarjetas con su enlace, para «¿qué hay de mis temas?» fuera del resumen. */
export function tarjetasTexto(tarjetas: readonly Tarjeta[], temas: readonly string[]): string {
  if (temas.length === 0) {
    return 'No sigo ningún tema todavía. Dime «sígueme el tema de …» y cada mañana te traigo lo nuevo en el resumen.';
  }
  if (tarjetas.length === 0) return `Nada nuevo de ${temas.join(', ')} en las últimas horas.`;
  return tarjetas.map((t) => `• ${tarjetaLine(t)}\n${t.url}`).join('\n');
}

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('add'),
      Type.Literal('remove'),
      Type.Literal('list'),
      Type.Literal('news'),
    ]),
    tema: Type.Optional(
      Type.String({
        description: 'add/remove: the topic, short («Sporting de Gijón», «Fórmula 1»).',
      }),
    ),
  }),
);

function reply(text: string, isError = false): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** Herramienta `temas`: «sígueme el tema de la F1», «deja de seguir…», «¿qué hay de mis temas?». */
export function createTemasTool(deps: {
  store: TemasStore;
  /** Los temas de verdad (los suyos + su equipo apuntado). */
  temas: () => string[];
  news: () => Promise<Tarjeta[]>;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'temas',
    label: 'Temas',
    description: [
      "Topics the user follows: each morning the daily summary brings last night's headlines",
      'about them («Tus temas»), with source. action=add when they say «sígueme el tema de X»,',
      '«quiero noticias de X por la mañana»; remove («deja de seguir X»); list; news = the',
      'latest headlines now, with links («¿qué hay de mis temas?»). Max 5 topics.',
    ].join('\n'),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const tema = String(args.tema ?? '').trim();
      if (args.action === 'add') {
        const err = deps.store.add(tema);
        if (err) return reply(err, true);
        return reply(
          `Sigo «${tema}»: cada mañana te traigo lo nuevo en el resumen (sección «Tus temas»). Temas: ${deps.temas().join(', ')}.`,
        );
      }
      if (args.action === 'remove') {
        const gone = deps.store.remove(tema);
        return reply(
          gone.length
            ? `Ya no sigo: ${gone.join(', ')}.`
            : `No seguía «${tema}». Temas: ${deps.temas().join(', ') || 'ninguno'}.`,
        );
      }
      if (args.action === 'news') return reply(tarjetasTexto(await deps.news(), deps.temas()));
      const all = deps.temas();
      return reply(all.length ? `Sigo: ${all.join(', ')}.` : tarjetasTexto([], []));
    },
  };
}
