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

/** Botones «Sí» / «No» si el texto acaba con una pregunta cerrada; si no, undefined. */
export function quickReplyButtons(
  text: string,
): Array<{ label: string; action: string }> | undefined {
  if (!isYesNoQuestion(text)) return undefined;
  return [
    { label: ANSWERS.si as string, action: `${QUICK_REPLY_PREFIX}si` },
    { label: ANSWERS.no as string, action: `${QUICK_REPLY_PREFIX}no` },
  ];
}

/** El texto que «escribe» un botón de respuesta rápida, o null si no es uno válido. */
export function quickReplyText(code: string): string | null {
  return Object.hasOwn(ANSWERS, code) ? (ANSWERS[code] as string) : null;
}
