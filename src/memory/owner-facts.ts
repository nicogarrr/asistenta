/**
 * Lo que el dueño cuenta de sí mismo, guardado al momento y a la vista, como lo haría
 * un buen asistente: «mi dentista es el Dr. García» se apunta sin preguntar, «¿qué
 * sabes de mí?» lo enseña todo en corto y «olvida eso» lo borra.
 *
 * Usa el perfil que ya existe (src/memory/snapshot.ts: el bloque <perfil> del
 * prompt); no es otra memoria. Antes una frase así solo provocaba la pregunta «¿lo
 * guardo?» y se apuntaba sola cuando se repetía varios días.
 */
import { foldAccents } from '../text.js';

/** Prefijo de lo que el dueño dijo él mismo (las autoguardadas llevan «[auto]»). */
export const SAID_PREFIX = '[dicho]';

/** Palabras que hacen la frase pasajera: eso es un pendiente, no un dato sobre él. */
const TEMPORARY =
  /\b(?:hoy|mañana|manana|ayer|esta (?:tarde|noche|mañana|semana)|ahora|luego|el (?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo))\b/i;

/** Coletillas que no cambian el dato. */
const TRAILER = /\s*,?\s*(?:gracias|porfa|por favor|vale|ok)\s*[.!]*$/i;

const STATED: readonly RegExp[] = [
  // «recuerda que…», «ten en cuenta que…», «apunta que…» (no «recuérdame…»: eso es un aviso)
  /^(?:recuerda|acuérdate|acuerdate|ten en cuenta|apunta|que sepas)\s+(?:de\s+)?que\s+\S/i,
  // «mi dentista es…», «mis padres viven en…», «mi hermana se llama…»
  /^mis?\s+[\p{L}-]+(?:\s+[\p{L}-]+){0,3}\s+(?:es|son|se llama|se llaman|vive|viven|está|están|trabaja)\s+\S/iu,
  /^(?:me llamo|vivo en|trabajo en|trabajo de|soy de|nací el|naci el|mi cumple(?:años)? es)\s+\S/i,
  /^soy\s+(?:alérgic|alergic|vegetarian|vegan|celíac|celiac|intolerante|diabétic|diabetic)/i,
  /^tengo\s+(?:un|una|dos|tres)\s+(?:perr|gat|hij|herman)/i,
  // preferencias sobre cómo tratarle
  /^(?:no me (?:escribas|mandes|envíes|envies|llames|hables|avises|despiertes|molestes)|prefiero|me gusta|no me gusta|me encanta|odio)\s+\S/i,
];

/**
 * El dato a guardar si el mensaje ENTERO es una frase sobre él mismo; null si no.
 * Una pregunta, una condición, algo pasajero o un mensaje que además pide otra cosa
 * no se guarda: eso es conversación, no un dato.
 */
export function statedFact(text: string): string | null {
  const one = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILER, '')
    .replace(/[.!]+$/, '');
  if (one.length < 8 || one.length > 140) return null;
  // «antes de las 9 de la mañana» es una hora, no «mañana»: no la hace pasajera.
  const timeless = one.replace(/(\d(?:\s+y\s+(?:media|cuarto))?)\s+de la ma(?:ñ|n)ana\b/gi, '$1');
  if (/[?¿]/.test(one) || /^si\s/i.test(one) || TEMPORARY.test(timeless)) return null;
  // Otra frase detrás («…, ayúdame con…», «…. Mira esto») es otro pedido.
  // «antes de las 8:30» es una hora, no otra frase: antes los dos puntos la descartaban y
  // esas horas de silencio no se apuntaban nunca.
  const plain = one
    .replace(/\b(?:dr|dra|sr|sra|d|dña)\.\s/giu, '')
    .replace(/(\d):(?=\d{2}\b)/g, '$1h');
  if (/,|;|:|[.!]\s+\p{L}/u.test(plain)) return null;
  if (!STATED.some((re) => re.test(one))) return null;
  return one.charAt(0).toUpperCase() + one.slice(1);
}

/** «¿qué sabes de mí?», «qué recuerdas de mí», «qué tienes apuntado de mí». */
export function isAboutMeRequest(text: string): boolean {
  const t = foldAccents(text.toLowerCase())
    .replace(/[¿?¡!.]/g, '')
    .trim();
  return /^(?:y\s+)?(?:que|qué)\s+(?:sabes|recuerdas|tienes apuntado|tienes guardado|sabes tu)\s+(?:de|sobre)\s+mi$/.test(
    t,
  );
}

/** Palabras que no dicen de qué tema se habla. */
const TOPIC_STOP = new Set(
  'de del la el los las lo un una unos unas mi mis tu tus su sus que y o a al en con sobre para por eso esto'.split(
    ' ',
  ),
);

/**
 * «¿qué recuerdas del dentista?», «qué tienes apuntado sobre el coche», «qué sabes de mi
 * hermana»: el tema por el que pregunta; null si no es eso (o si es «de mí»: eso es
 * {@link isAboutMeRequest}). Con «sabes» solo vale «de mi/mis …»: «¿qué sabes de Python?»
 * es una pregunta de cultura, no de lo que tengo apuntado de él.
 */
export function aboutTopicRequest(text: string): string | null {
  const t = foldAccents(text.replace(/\s+/g, ' '))
    .replace(/[¿?¡!.]/g, '')
    .trim();
  const m =
    /^(?:y\s+)?que\s+(sabes|recuerdas|te acuerdas|tienes apuntado|tienes guardado|te dije|te he dicho|te conte|te he contado)\s+(?:tu\s+)?(?:de|del|sobre|acerca de|acerca del)\s+(.{2,60})$/.exec(
      t,
    );
  if (!m?.[1] || !m[2]) return null;
  const topic = m[2].trim();
  if (/^(?:mi|ti|mi mismo|nosotros)$/.test(topic)) return null;
  if (m[1] === 'sabes' && !/^mis?\s/.test(topic)) return null;
  const words = topicWords(topic);
  return words.length > 0 ? topic : null;
}

function topicWords(topic: string): string[] {
  return foldAccents(topic)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !TOPIC_STOP.has(w));
}

/** ¿La palabra del tema está en la entrada? «padres» casa con «padre», «coche» con «coches». */
function wordIn(word: string, tokens: readonly string[]): boolean {
  const stem = word.length >= 5 ? word.slice(0, Math.max(4, word.length - 2)) : word;
  return tokens.some((t) =>
    word.length >= 5 ? t.startsWith(stem) : t === word || t === `${word}s`,
  );
}

/**
 * Las entradas del perfil que hablan del tema: primero las que tienen todas sus palabras;
 * si ninguna, las que tienen alguna.
 */
export function entriesAbout(entries: readonly string[], topic: string): string[] {
  const words = topicWords(topic);
  if (words.length === 0) return [];
  const tokenized = entries
    .filter((e) => e.trim())
    .map((e) => ({ e, tokens: foldAccents(showEntry(e)).split(/[^\p{L}\p{N}]+/u) }));
  const all = tokenized.filter((x) => words.every((w) => wordIn(w, x.tokens))).map((x) => x.e);
  if (all.length > 0) return all;
  return tokenized.filter((x) => words.some((w) => wordIn(w, x.tokens))).map((x) => x.e);
}

/** La respuesta a «¿qué recuerdas de X?» con lo que hay apuntado; null si no hay nada. */
export function aboutTopicText(entries: readonly string[], topic: string, max = 10): string | null {
  const found = entriesAbout(entries, topic).map(showEntry).filter(Boolean);
  if (found.length === 0) return null;
  const last = found.slice(-max);
  const hidden = found.length - last.length;
  const more = hidden > 0 ? `\n(y ${hidden} más)` : '';
  const label = topic.replace(/^(?:mis?|el|la|los|las)\s+/i, '');
  return `Sobre ${label} tengo apuntado:\n${last.map((e) => `• ${e}`).join('\n')}${more}\n\nPara borrar algo: «olvida lo de ${label}».`;
}

export type ForgetRequest = { kind: 'last' } | { kind: 'match'; query: string };

/** «olvida eso», «olvídalo», «olvida lo del dentista», «borra lo de que vivo en Madrid». */
export function forgetRequest(text: string): ForgetRequest | null {
  const t = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TRAILER, '')
    .replace(/[.!]+$/, '');
  if (/^(?:olvida|borra)\s+eso$|^olv[ií]dalo$|^b[oó]rralo$|^no lo recuerdes$/i.test(t)) {
    return { kind: 'last' };
  }
  // «olvida lo de…», y también «olvida lo que te dije del dentista».
  const m =
    /^(?:olvida|borra|olvídate de|olvidate de)\s+lo\s+(?:que\s+te\s+(?:dije|conté|conte)\s+(?:de|del|sobre)|de|del)\s+(?:que\s+)?(.{2,60})$/i.exec(
      t,
    );
  if (m?.[1]) return { kind: 'match', query: m[1].replace(/^(?:la|el|los|las|mi|mis)\s+/i, '') };
  // «olvida que mi dentista es el Dr. García», «borra que vivo en Getafe»: lo que sigue es un
  // dato de los que se apuntan. Antes no se reconocía y lo llevaba el modelo, que no borra del
  // perfil. De «mi(s) X es/vive…» se olvida todo lo de «mi X» (el valor puede haber cambiado).
  const said = /^(?:olvida|borra|olvídate de|olvidate de)\s+que\s+(.{2,140})$/i.exec(t)?.[1];
  if (said && statedFact(said)) {
    const subject =
      /^(mis?\s+[\p{L}-]+(?:\s+[\p{L}-]+){0,3}?)\s+(?:es|son|se llama|se llaman|vive|viven|está|están|trabaja)\s/iu.exec(
        said,
      )?.[1];
    return { kind: 'match', query: subject ?? said };
  }
  return null;
}

/** Una entrada del perfil tal como se le enseña al dueño: sin prefijos internos. */
function showEntry(entry: string): string {
  const clean = entry
    .replace(/^\[(?:auto|dicho)\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 90 ? `${clean.slice(0, 89).trimEnd()}…` : clean;
}

/** La respuesta a «¿qué sabes de mí?»: corta, en llano y diciendo cómo borrar. */
export function aboutMeText(entries: readonly string[], max = 15): string {
  const shown = entries.map(showEntry).filter(Boolean);
  if (shown.length === 0) {
    return 'Todavía no tengo nada apuntado sobre ti. Si me cuentas algo («mi dentista es…», «no me escribas antes de las 9»), lo apunto.';
  }
  const last = shown.slice(-max);
  const hidden = shown.length - last.length;
  const more =
    hidden > 0 ? `\n(y ${hidden} ${hidden === 1 ? 'cosa más antigua' : 'cosas más antiguas'})` : '';
  return `Esto es lo que sé de ti:\n${last.map((e) => `• ${e}`).join('\n')}${more}\n\nPara borrar algo: «olvida lo de …».`;
}

/** La confirmación de «olvida…»: dice qué se ha borrado, no solo «hecho». */
export function forgotLine(removed: readonly string[]): string {
  const shown = removed.map(showEntry).filter(Boolean);
  if (shown.length === 0) return 'Ya no lo tenía apuntado.';
  if (shown.length === 1) return `Hecho, ya no recuerdo «${shown[0]}».`;
  const list = shown.slice(0, 3).map((e) => `«${e}»`);
  const more = shown.length > 3 ? ` y ${shown.length - 3} más` : '';
  return `Hecho, he olvidado ${shown.length} cosas: ${list.join(', ')}${more}.`;
}

/** La línea que confirma que algo se apuntó, si la respuesta no lo dice ya. */
export const FACT_SAVED_LINE = '📝 Apuntado. Si no quieres que lo recuerde, dime «olvida eso».';

/** Igual, diciendo qué se apuntó: así se ve si lo entendió bien. */
export function factSavedLine(entry: string): string {
  const shown = showEntry(entry);
  if (!shown) return FACT_SAVED_LINE;
  return `📝 Apuntado: «${shown}». Si no quieres que lo recuerde, dime «olvida eso».`;
}

/** Cuánto vale un «olvida eso» después de apuntar algo. */
export const FORGET_LAST_WINDOW_MS = 30 * 60_000;

/** Lo último apuntado por chat, para que «olvida eso» sepa qué es «eso». */
export class RecentFacts {
  readonly #last = new Map<string, { entry: string; at: number }>();

  remember(chat: string, entry: string, at = Date.now()): void {
    this.#last.set(chat, { entry, at });
  }

  /** La entrada recién apuntada en ese chat, sin sacarla. */
  peek(chat: string, now = Date.now()): string | null {
    const last = this.#last.get(chat);
    return last && now - last.at <= FORGET_LAST_WINDOW_MS ? last.entry : null;
  }

  /** La entrada recién apuntada en ese chat, y la olvida de aquí. */
  take(chat: string, now = Date.now()): string | null {
    const last = this.#last.get(chat);
    this.#last.delete(chat);
    if (!last || now - last.at > FORGET_LAST_WINDOW_MS) return null;
    return last.entry;
  }
}
