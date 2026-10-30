/**
 * El texto que se va a decir en voz alta (nota de voz, altavoz, tele): sin
 * Markdown, sin emojis ni símbolos que la voz lee por su nombre, y cortado en un
 * fin de frase. Movido tal cual desde cli.ts (paso P2 de ARCHITECTURE.md); cli.ts
 * lo reexporta para no cambiar ningún import.
 */

/**
 * Text destined for speech.
 *
 * Markdown is read terribly aloud, and a 900-character answer becomes a 90-second
 * voice note nobody asked for. Code blocks are dropped entirely and replaced by a
 * marker, because a model quoting a stack trace at 2am on a phone is useless.
 */
export function trimForSpeech(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' (bloque de codigo omitido) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    // Emojis y viñetas: la voz los lee como nombres («cara sonriente», «guion»).
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .replace(/^[ \t]*[-•·][ \t]+/gm, '')
    // Símbolos de texto que no son emoji: flechas, estrellas, marcas, cajas. SAPI
    // los lee por su nombre («flecha a la derecha», «estrella negra») o se traba.
    .replace(
      /[ \t]*(?:[\u2190-\u21FF\u27F0-\u27FF\u2900-\u297F\u2B00-\u2B2F]|-{1,2}>|={1,2}>|<-{1,2})[ \t]*/g,
      ', ',
    )
    .replace(/[\u2600-\u27BF\u25A0-\u25FF\u2700-\u27BF\u2022\u2023\u2043\u2219\u00B7]/g, ' ')
    // Un salto de línea sin puntuación (listas) es una pausa, no una frase pegada.
    .replace(/([^\s.!?…:;,])[ \t]*\n+/g, '$1. ')
    .replace(/[*_#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= 900) return cleaned;
  // Cortar en el último fin de frase (o palabra) antes del tope: nunca a media palabra.
  const head = cleaned.slice(0, 900);
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('? '),
    head.lastIndexOf('! '),
  );
  const cut =
    sentenceEnd >= 450
      ? sentenceEnd + 1
      : head.lastIndexOf(' ') >= 450
        ? head.lastIndexOf(' ')
        : 900;
  return `${cleaned.slice(0, cut).trimEnd()}...`;
}
