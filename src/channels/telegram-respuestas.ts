/**
 * Respuestas rápidas: cuando Asistenta acaba su respuesta con una pregunta de sí o no
 * («¿Quieres que te lo apunte?», «¿Lo envío?»), la respuesta trae dos botones, «Sí» y
 * «No». Un toque equivale a escribirlo. Antes había que teclear «sí» cada vez, que es
 * justo lo que más se repite en un chat con un asistente.
 *
 * Conservador a propósito: solo preguntas cerradas que empiezan como una propuesta,
 * sin alternativas («¿hoy o mañana?») ni preguntas abiertas («¿a qué hora?»).
 *
 * Puro: se prueba sin bot ni red.
 */

export const QUICK_REPLY_PREFIX = 'qr:';
/** Botón que queda tras contestar, para que se vea qué se eligió. No hace nada. */
export const QUICK_REPLY_DONE = `${QUICK_REPLY_PREFIX}hecho`;

const ANSWERS: Readonly<Record<string, string>> = { si: 'Sí', no: 'No' };

/** Comienzos de una propuesta cerrada (sin tildes, en minúscula). */
const START =
  /^(?:(?:lo|la|los|las|le|les|se) [a-z]|(?:quieres|quiere|te (?:(?:lo|la|los|las) )?(?:parece|vale|apunto|mando|envio|aviso|recuerdo|pongo|digo|busco|reservo|compro|preparo|hago|leo|cuento|paso|resumo|traduzco|guardo|anoto|programo|llamo|ayudo|lo|la)|confirmas|confirmo|sigo|continuo|procedo|hago|envio|mando|pongo|apunto|anoto|guardo|borro|elimino|compro|pido|reservo|anado|activo|desactivo|programo|cambio|abro|cierro|busco|preparo|llamo|respondo|contesto|cancelo|seguimos|empiezo|arranco|instalo|actualizo|aplico|publico|descargo|reinicio|apago|enciendo|puedo|prefieres que|vale|de acuerdo)\b)/;

/** Alternativas o preguntas abiertas: ahí «Sí / No» no contesta nada. */
const OPEN =
  /\b(?:o|u|cual|cuales|cuando|donde|adonde|como|cuanto|cuanta|cuantos|cuantas|quien|quienes|de que|en que|a que|por que|para que|con que|que hora|que dia)\b/;

/** La pregunta final del texto, o null si no acaba en pregunta. */
function lastQuestion(text: string): string | null {
  const trimmed = text
    .trim()
    .replace(/(?:\s|[*_~`]|\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u, '')
    .trimEnd();
  if (!trimmed.endsWith('?')) return null;
  const open = trimmed.lastIndexOf('¿');
  const from =
    open >= 0
      ? open
      : Math.max(-1, ...['.', '!', '\n'].map((c) => trimmed.lastIndexOf(c, trimmed.length - 2))) +
        1;
  const q = trimmed.slice(from).trim();
  if (q.includes('\n')) return null;
  return q;
}

/** ¿Acaba el texto con una pregunta de sí o no? */
export function isYesNoQuestion(text: string): boolean {
  const q = lastQuestion(text);
  if (!q || q.length > 140) return false;
  const norm = q
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[¿?*_]/g, '')
    .replace(/^(?:y|entonces|vale|pues|bueno|oye|ok)[\s,]+/, '')
    .trim();
  if (!START.test(norm)) return false;
  return !OPEN.test(norm);
}

/** Botón de una opción de «¿A o B?»: `qr:o1`… El texto es la etiqueta del propio botón. */
export const CHOICE_CODE = /^o[1-4]$/;

/** Palabras que abren una opción y se buscan atrás para cortar la primera («por correo»). */
const OPENERS = new Set(
  'a al con de del el en la las lo los para por sin un una unos unas mi tu su'.split(' '),
);

/** Un arranque de pregunta antes de la lista («Cuál prefieres», «Qué te viene mejor»). */
const LEAD_IN =
  /^(?:cu[aá]l(?:es)?|qu[eé]|prefieres|quieres|te |os |lo |la |vamos|mejor|entonces|y )/i;

/** Lo más largo que puede ser una opción para ir en un botón. */
const OPTION_MAX_CHARS = 32;
const OPTION_MAX_WORDS = 4;

/**
 * Las opciones de una pregunta «¿A o B?» al final del texto («¿Hoy o mañana?», «¿Te lo
 * mando por correo o por WhatsApp?», «¿El rojo, el azul o el verde?»), o null si no la
 * hay. La primera opción se corta donde empieza su pareja: misma palabra de arranque
 * («por correo» / «por WhatsApp») o, si no, el mismo número de palabras. Conservador:
 * de 2 a 4 opciones cortas; «¿… o no?» y preguntas con «¿qué…/¿cuándo…» sin lista no.
 */
export function choiceOptions(text: string): string[] | null {
  const q = lastQuestion(text);
  if (!q || q.length > 140) return null;
  const body = q
    .replace(/^¿/, '')
    .replace(/\?$/, '')
    .replace(/[*_~`]/g, '')
    .trim();
  const parts = body.split(/\s+[ou]\s+/);
  if (parts.length !== 2) return null;
  const [head, last] = parts.map((p) => p.trim()) as [string, string];
  const lastWords = last.split(/\s+/);
  if (!last || /^no$/i.test(last) || lastWords.length > OPTION_MAX_WORDS) return null;
  // «el rojo, el azul o el verde»: lo anterior a la última coma son más opciones.
  const listed = head.split(/\s*,\s*/);
  const middle = listed.length > 1 ? listed.slice(1) : [];
  const firstChunk = (listed[0] ?? '').split(/\s+/);
  const opener = (lastWords[0] ?? '').toLowerCase();
  let first: string[];
  const at = firstChunk.map((w) => w.toLowerCase()).lastIndexOf(opener);
  if (middle.length && (at < 0 || !OPENERS.has(opener))) {
    // «¿Cuál prefieres, el rojo o el azul?»: lo de antes de la coma es la pregunta; en
    // «¿Hoy, mañana o el viernes?» es la primera opción.
    first = LEAD_IN.test(listed[0] ?? '') ? [] : firstChunk;
  } else if (OPENERS.has(opener)) {
    if (at < 0) return null;
    first = firstChunk.slice(at);
  } else {
    // Sin palabra de arranque, por número de palabras: solo con opciones de 1 o 2.
    if (lastWords.length > 2) return null;
    first = firstChunk.slice(-Math.min(lastWords.length, firstChunk.length));
  }
  const options = [first.join(' '), ...middle, last]
    .map((o) => o.replace(/^[:,;\s]+|[:,;\s]+$/g, '').trim())
    .filter(Boolean);
  if (options.length < 2 || options.length > 4) return null;
  for (const o of options) {
    if (o.length > OPTION_MAX_CHARS || o.split(/\s+/).length > OPTION_MAX_WORDS) return null;
    if (/^(?:que|si)\b/i.test(o)) return null;
  }
  // Dos opciones iguales («¿esto o esto?») no son una elección.
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  return options.map((o) => o.charAt(0).toUpperCase() + o.slice(1));
}

/**
 * Botones de respuesta rápida para el final del texto: «Sí» / «No» si es una pregunta
 * cerrada, un botón por opción si es «¿A o B?»; si no, undefined.
 */
export function quickReplyButtons(
  text: string,
): Array<{ label: string; action: string }> | undefined {
  if (isYesNoQuestion(text))
    return [
      { label: ANSWERS.si as string, action: `${QUICK_REPLY_PREFIX}si` },
      { label: ANSWERS.no as string, action: `${QUICK_REPLY_PREFIX}no` },
    ];
  const options = choiceOptions(text);
  if (!options) return undefined;
  return options.map((label, i) => ({ label, action: `${QUICK_REPLY_PREFIX}o${i + 1}` }));
}

/** El texto que «escribe» un botón de respuesta rápida, o null si no es uno válido. */
export function quickReplyText(code: string): string | null {
  return Object.hasOwn(ANSWERS, code) ? (ANSWERS[code] as string) : null;
}

/**
 * El texto de un botón de opción (`qr:o2`): su propia etiqueta, leída del teclado del
 * mensaje que lo lleva. Sin estado que se pierda al reiniciar. Null si no está.
 */
export function choiceText(code: string, markup: unknown): string | null {
  if (!CHOICE_CODE.test(code)) return null;
  const rows = (markup as { inline_keyboard?: unknown })?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const b of row as Array<{ text?: unknown; callback_data?: unknown }>) {
      if (b?.callback_data === `${QUICK_REPLY_PREFIX}${code}` && typeof b.text === 'string')
        return b.text.trim() || null;
    }
  }
  return null;
}
