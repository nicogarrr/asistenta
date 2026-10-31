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
  /^(?:no me (?:escribas|mandes|llames|hables|avises|despiertes)|prefiero|me gusta|no me gusta|me encanta|odio)\s+\S/i,
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
  if (/[?¿]/.test(one) || /^si\s/i.test(one) || TEMPORARY.test(one)) return null;
  // Otra frase detrás («…, ayúdame con…», «…. Mira esto») es otro pedido.
  if (/,|;|:|[.!]\s+\p{L}/u.test(one.replace(/\b(?:dr|dra|sr|sra|d|dña)\.\s/giu, ''))) return null;
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
  const m =
    /^(?:olvida|borra|olvídate de|olvidate de)\s+lo\s+(?:de|del)\s+(?:que\s+)?(.{2,60})$/i.exec(t);
  if (m?.[1]) return { kind: 'match', query: m[1].replace(/^(?:la|el|los|las|mi|mis)\s+/i, '') };
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
  const more =
    shown.length > last.length ? `\n(y ${shown.length - last.length} cosas más antiguas)` : '';
  return `Esto es lo que sé de ti:\n${last.map((e) => `• ${e}`).join('\n')}${more}\n\nPara borrar algo: «olvida lo de …».`;
}

/** La línea que confirma que algo se apuntó, si la respuesta no lo dice ya. */
export const FACT_SAVED_LINE = '📝 Apuntado. Si no quieres que lo recuerde, dime «olvida eso».';

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
