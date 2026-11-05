import { sliceSafe } from '../text.js';

/** Mensajes de log de una reacción del dueño: /estado los cuenta (src/status.ts), sin leer campos. */
export const REACTION_LOG_MSG = 'telegram reaction';
export const REACTION_NEGATIVE_LOG_MSG = 'telegram reaction negativa';

/**
 * Reacciones del dueño a los mensajes de Asistenta.
 *
 * En Telegram lo natural es reaccionar: un 👎 a una respuesta que no sirve, un 🤔 a
 * algo que no cuadra. Antes el bot ni se enteraba (no pedía esas actualizaciones) y la
 * crítica se perdía. Ahora una reacción de duda o de rechazo a una respuesta reciente
 * suya llega al asistente como un mensaje, citando lo que dijo, para que lo corrija o
 * pregunte qué falla. Un 👍 o un ❤️ no abre turno: contestar «¡de nada!» a cada pulgar
 * sería ruido.
 *
 * Puro: se prueba sin bot ni red.
 */

/** Lo que trae Telegram en `old_reaction` / `new_reaction` (ReactionType). */
export interface ReactionLike {
  type?: string;
  emoji?: string;
}

export type ReactionMood = 'negativa' | 'positiva' | 'otra';

/** Sin el selector de variante (U+FE0F): «❤️» y «❤» son la misma reacción. */
function bare(emoji: string): string {
  return emoji.replace(/\uFE0F/g, '').trim();
}

/** Duda, rechazo o enfado: piden que el asistente revise lo que dijo. */
const NEGATIVE = new Set(
  [
    '👎',
    '🤔',
    '🤨',
    '😢',
    '😭',
    '😡',
    '🤬',
    '💩',
    '🤮',
    '😐',
    '🥴',
    '🙄',
    '😨',
    '💔',
    '🤡',
    '🖕',
  ].map(bare),
);

/** Aprobación o cariño: se toma nota, sin turno. */
const POSITIVE = new Set(
  [
    '👍',
    '❤️',
    '❤',
    '🔥',
    '👏',
    '🙏',
    '💯',
    '😁',
    '🎉',
    '🤩',
    '🥰',
    '👌',
    '😍',
    '🏆',
    '⚡',
    '🤝',
    '😂',
    '🤣',
    '💘',
    '😘',
    '🤗',
    '🫡',
    '😎',
    '❤‍🔥',
    '🍾',
    '🆒',
    '✍️',
    '👨‍💻',
  ].map(bare),
);

export function reactionMood(emoji: string): ReactionMood {
  const e = bare(emoji);
  if (NEGATIVE.has(e)) return 'negativa';
  if (POSITIVE.has(e)) return 'positiva';
  return 'otra';
}

/**
 * Los emojis que se acaban de poner (los nuevos que no estaban). Quitar una reacción
 * no es decir nada; los emojis personalizados y las estrellas de pago se ignoran.
 */
export function addedEmojis(
  oldReaction: readonly ReactionLike[] | undefined,
  newReaction: readonly ReactionLike[] | undefined,
): string[] {
  const emojis = (list: readonly ReactionLike[] | undefined): string[] =>
    (list ?? [])
      .filter((r) => r?.type === 'emoji' && typeof r.emoji === 'string' && r.emoji.trim())
      .map((r) => (r.emoji as string).trim());
  const before = new Set(emojis(oldReaction).map(bare));
  return emojis(newReaction).filter((e) => !before.has(bare(e)));
}

/** Largo máximo de la cita del mensaje propio en el texto de la reacción. */
const QUOTE_MAX = 300;

/**
 * El texto que recibe el asistente: la reacción y lo que dijo él, recortado. Empieza
 * por «[», así que nunca se toma por un comando.
 */
export function reactionText(emoji: string, said: string): string {
  const flat = said.replace(/\s+/g, ' ').replace(/[«»]/g, '"').trim();
  const cut = sliceSafe(flat, QUOTE_MAX);
  const quoted = cut.length < flat.length ? `${cut.trimEnd()}…` : cut;
  const what =
    reactionMood(emoji) === 'negativa'
      ? 'no le convence: revisa esa respuesta y corrígela, o pregunta en una frase qué falla'
      : 'reacción a tu mensaje';
  return `[Reacción ${emoji} a tu mensaje «${quoted}» — ${what}]`;
}
