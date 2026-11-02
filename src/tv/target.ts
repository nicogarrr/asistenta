/**
 * A qué tele va una orden cuando en casa hay varias.
 *
 * - «baja el volumen de la tele del salón», «enciende la del dormitorio»,
 *   «pon Netflix en el salón»: el nombre se reconoce SOLO si es el de una tele
 *   guardada (`pa tv nombre`), sin tildes ni mayúsculas; la frase de lugar se
 *   quita para que el parser de siempre (natural.ts) entienda la orden.
 * - Sin nombre: la tele activa, exactamente como antes.
 * - «la tele del garaje» con varias teles y ninguna se llama así, o un nombre
 *   que encaja con dos: se pregunta cuál, sin tocar ninguna.
 *
 * La orden se ejecuta dentro de `withTvTarget`: el cableado de la tool lee la
 * tele de aquí (AsyncLocalStorage) en vez de las claves de la activa, así una
 * orden a la del dormitorio nunca acaba en la del salón.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { type KnownTv, normalizeTvName } from './registry.js';

const store = new AsyncLocalStorage<KnownTv>();

/** Tele a la que va la orden en curso; undefined = la activa de siempre. */
export function currentTvTarget(): KnownTv | undefined {
  return store.getStore();
}

export function withTvTarget<T>(tv: KnownTv, fn: () => Promise<T>): Promise<T> {
  return store.run(tv, fn);
}

/** Nombre corto para mensajes: «Salón» o la IP. */
export function tvTargetLabel(tv: KnownTv): string {
  return tv.name ?? tv.host;
}

/** Quita tildes letra a letra (mantiene la longitud para poder cortar el original). */
function foldChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const folded = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out += folded.length === ch.length ? folded.toLowerCase() : ch.toLowerCase();
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TV_NOUN = '(?:tele|television|tv|televisor|tdt)';
const PLACE_PREP = '(?:del|de la|de el|de|en el|en la|en)';

/** Formas de nombrar una tele: su nombre entero y, si es «[LG] webOS TV Dormitorio», la última palabra. */
function nameVariants(tv: KnownTv, all: readonly KnownTv[]): string[] {
  if (!tv.name) return [];
  const full = normalizeTvName(tv.name);
  const out = full ? [full] : [];
  const last = full.split(' ').at(-1) ?? '';
  const lastIsUnique = all.every(
    (o) => o === tv || !o.name || normalizeTvName(o.name).split(' ').at(-1) !== last,
  );
  if (last.length >= 4 && last !== full && lastIsUnique && !/^(tv|tele|webos|lg)$/.test(last)) {
    out.push(last);
  }
  return out;
}

/** Patrones de lugar para un nombre, del más largo al más corto, con su sustituto. */
function placePatterns(name: string): Array<{ re: RegExp; repl: string }> {
  const n = escapeRe(name).replace(/ /g, '\\s+');
  const end = '(?=$|[\\s,.;:!?¡¿)]|\\s+y\\s)';
  return [
    // «de la tele del salón» → «de la tele»
    {
      re: new RegExp(`\\b(de|en|a) la ${TV_NOUN}\\s+${PLACE_PREP}\\s+${n}${end}`),
      repl: '$1 la tele',
    },
    // «la tele del salón» → «la tele»
    { re: new RegExp(`\\bla ${TV_NOUN}\\s+${PLACE_PREP}\\s+${n}${end}`), repl: 'la tele' },
    // «el televisor del salón»
    { re: new RegExp(`\\bel ${TV_NOUN}\\s+${PLACE_PREP}\\s+${n}${end}`), repl: 'la tele' },
    // «enciende la del dormitorio» → «enciende la tele»
    { re: new RegExp(`\\bla (?:del|de la|de)\\s+${n}${end}`), repl: 'la tele' },
    // «pon Netflix en el salón» → «pon Netflix»
    { re: new RegExp(`\\s+(?:en el|en la|en|del|de la)\\s+${n}${end}`), repl: '' },
  ];
}

export interface TvTargetResult {
  /** Orden sin la frase de lugar (igual que la original si no había). */
  text: string;
  /** Tele nombrada; undefined = la activa. */
  tv?: KnownTv;
  /** Pregunta al dueño (no se toca ninguna tele). */
  ask?: string;
}

function listForAsk(known: readonly KnownTv[]): string {
  return known.map((t) => (t.name ? `«${t.name}» (${t.host})` : t.host)).join(', ');
}

/**
 * Busca en la orden el nombre de una tele guardada. Con una sola tele y sin
 * nombres que encajen, el texto vuelve tal cual: nada cambia para quien tiene una.
 */
export function extractTvTarget(text: string, known: readonly KnownTv[]): TvTargetResult {
  const folded = foldChars(text);
  if (folded.length !== text.length || known.length === 0) return { text };
  const hits: Array<{ tv: KnownTv; start: number; end: number; repl: string }> = [];
  for (const tv of known) {
    let best: { start: number; end: number; repl: string } | undefined;
    for (const name of nameVariants(tv, known)) {
      for (const { re, repl } of placePatterns(name)) {
        const m = re.exec(folded);
        if (!m) continue;
        const matched = m[0].replace(re, repl);
        const cand = { start: m.index, end: m.index + m[0].length, repl: matched };
        if (!best || cand.end - cand.start > best.end - best.start) best = cand;
        break;
      }
    }
    if (best) hits.push({ tv, ...best });
  }
  // «la tele del salón grande» no es ambigua con «salón»: gana la frase más larga que la contiene.
  const kept = hits.filter(
    (h) =>
      !hits.some(
        (o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start,
      ),
  );
  hits.splice(0, hits.length, ...kept);
  const distinct = [...new Set(hits.map((h) => h.tv.host))];
  if (distinct.length > 1) {
    return {
      text,
      ask: `¿A qué tele? En la orden encajan varias: ${listForAsk(hits.map((h) => h.tv))}. Dímelo con un nombre solo.`,
    };
  }
  const hit = hits[0];
  if (hit) {
    const cleaned = `${text.slice(0, hit.start)}${hit.repl}${text.slice(hit.end)}`
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { text: cleaned, tv: hit.tv };
  }
  // «la tele del garaje» con varias teles: no adivinar cuál.
  if (known.length > 1) {
    const unknown = new RegExp(
      `\\b(?:la|el) ${TV_NOUN}\\s+(?:del|de la|de el)\\s+([a-zñ0-9]{3,})`,
    ).exec(folded);
    const unknownLa = /\bla (?:del|de la)\s+([a-zñ0-9]{3,})/.exec(folded);
    const place = unknown?.[1] ?? unknownLa?.[1];
    if (place) {
      return {
        text,
        ask: `No tengo ninguna tele que se llame «${place}». Tengo: ${listForAsk(known)}. Ponle nombre con «pa tv nombre <ip> ${place}» o dime cuál.`,
      };
    }
  }
  return { text };
}

/**
 * Para filtros previos que solo tienen el texto (el /tv del chat, `pa tv
 * orden`): quita una frase de lugar genérica («de la tele del salón», «la del
 * dormitorio») para saber si lo demás es una orden. La tele de verdad la
 * resuelve `extractTvTarget` con el registro.
 */
export function withoutTvPlace(text: string): string {
  return text
    .replace(
      /\b(la (?:tele|televisi[oó]n|tv))\s+(?:del|de la|en el|en la)\s+[\p{L}\d]+(?:\s+[\p{L}\d]+)?(?=$|[\s,.;:!?])/iu,
      '$1',
    )
    .replace(/\bla (?:del|de la)\s+[\p{L}\d]+(?=$|[\s,.;:!?])/iu, 'la tele')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** El fallo es «no llegué a conectar»: no salió nada, se puede reintentar en otra IP. */
export function isTvUnreachable(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof Error && e.name === 'TvUnreachableError') return true;
    e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}
