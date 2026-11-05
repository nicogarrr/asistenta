/**
 * Preguntas directas sobre lo que el dueño contó: «¿quién es mi dentista?», «¿cómo se
 * llama mi hermana?», «¿dónde vive mi madre?», «¿te acuerdas de mi dentista?», «¿cuándo
 * es el cumple de mi madre?». Si lo tiene apuntado, contesta al momento con sus palabras
 * en segunda persona («Tu dentista es el Dr. García»), sin pasar por el modelo ni
 * arriesgarse a que lo invente. Si no hay nada que case del todo, null: lo lleva el modelo.
 *
 * Antes solo «¿qué recuerdas de…?» contestaba al momento (#1996); estas, las formas más
 * normales de preguntarlo, siempre iban al modelo.
 */
import { foldAccents } from '../text.js';

/** Palabras que no dicen de qué se habla. */
const STOP = new Set(
  'de del la el los las lo un una unos unas mi mis tu tus su sus que y o a al en con sobre para por eso esto es era cuando'.split(
    ' ',
  ),
);

function words(text: string): string[] {
  return foldAccents(text.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** El tema por el que pregunta, o null si no es una de estas preguntas. */
export function ownerQuestionTopic(text: string): string | null {
  const t = foldAccents(text.toLowerCase().replace(/\s+/g, ' '))
    .replace(/[¿?¡!.]/g, '')
    .trim();
  if (t.length > 80) return null;
  // Solo con «mi/mis»: «¿quién es Pedro Sánchez?» es cultura general, no algo apuntado.
  const mine =
    /^(?:y\s+)?(quien es|quienes son|como se llama|como se llaman|donde vive|donde viven|donde trabaja|donde trabajan|cual es|cuales son)\s+(mis?\s+.{2,50})$/.exec(
      t,
    );
  if (mine?.[1] && mine[2]) {
    // «¿dónde vive mi madre?» pide la entrada de dónde vive, no el cumple de su madre.
    const verb = /(llama|vive|trabaja)/.exec(mine[1])?.[1];
    return verb ? `${mine[2]} ${verb}` : mine[2];
  }
  const when =
    /^(?:y\s+)?cuando (?:es|cae) (?:el\s+)?((?:cumple(?:anos)?|aniversario|santo)\b.{0,50})$/.exec(
      t,
    );
  if (when?.[1]) return when[1];
  const remember =
    /^(?:y\s+)?(?:te acuerdas|recuerdas|sabes) (?:de|del|de la|de los|de las)\s+(.{2,50})$/.exec(t);
  if (remember?.[1] && !/^(?:mi|mi mismo|ti|lo que .*|que .*)$/.test(remember[1]))
    return remember[1];
  return null;
}

/**
 * ¿La palabra está en la entrada? Estricto (la palabra o su plural): «hermano» no casa con
 * «hermana», que sería contestar con otra persona. «cumpleaños» casa con «cumple».
 */
function has(word: string, tokens: readonly string[]): boolean {
  if (word.startsWith('cumple')) return tokens.some((t) => t.startsWith('cumple'));
  const verb = /^(llama|vive|trabaja)$/.exec(word)?.[1];
  if (verb) return tokens.some((t) => t.startsWith(verb.slice(0, -1)));
  return tokens.some(
    (t) =>
      t === word || t === `${word}s` || t === `${word}es` || `${t}s` === word || `${t}es` === word,
  );
}

function clean(entry: string): string {
  return entry
    .replace(/^\[(?:auto|dicho)\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «Mi dentista es…» → «Tu dentista es…»; «Me llamo…» → «Te llamas…». */
export function secondPerson(fact: string): string {
  const out = fact
    .replace(/\bmis\b/gi, (m) => (m[0] === 'M' ? 'Tus' : 'tus'))
    .replace(/\bmi\b/gi, (m) => (m[0] === 'M' ? 'Tu' : 'tu'))
    .replace(/^Me llamo\b/i, 'Te llamas')
    .replace(/^Vivo\b/i, 'Vives')
    .replace(/^Trabajo\b/i, 'Trabajas')
    .replace(/^Soy\b/i, 'Eres')
    .replace(/^Estoy\b/i, 'Estás')
    .replace(/^Tengo\b/i, 'Tienes');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** La respuesta con lo apuntado que casa con TODAS las palabras del tema; null si nada. */
export function answerOwnerQuestion(
  entries: readonly string[],
  text: string,
  max = 5,
): string | null {
  const topic = ownerQuestionTopic(text);
  if (!topic) return null;
  const want = words(topic);
  if (want.length === 0) return null;
  const hits = entries
    .map(clean)
    .filter(Boolean)
    .filter((e) => {
      const tokens = foldAccents(e.toLowerCase()).split(/[^\p{L}\p{N}]+/u);
      return want.every((w) => has(w, tokens));
    });
  if (hits.length === 0) return null;
  const shown = hits.slice(-max).map(secondPerson);
  if (shown.length === 1) return `${shown[0]} (lo tengo apuntado).`;
  return `Tengo apuntado:\n${shown.map((e) => `• ${e}`).join('\n')}`;
}
