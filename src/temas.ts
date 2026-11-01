/**
 * Lo que dice /topic sin mandar a «/topic main» (Nico, 1 nov: «como estamos hablando
 * nosotros»). Con otra conversación activa, «vuelve a la principal» vuelve a la de siempre.
 */

const A_LA_PRINCIPAL =
  /^(?:vuelve|volvamos|volver|vamos|regresa|cambia|p[aá]sate)\s+a\s+la\s+(?:conversaci[oó]n\s+)?principal[.!]*$/i;

export function backToMainAnswer(text: string): boolean {
  return A_LA_PRINCIPAL.test(text.trim());
}

export function topicReadyText(name: string): string {
  return name === 'main'
    ? 'De vuelta en la conversación principal.'
    : `Conversación "${name}" lista. Lo que escribas va aquí; cuando quieras volver a la principal, dime «vuelve a la principal».`;
}
