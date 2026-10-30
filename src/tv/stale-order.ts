/**
 * Órdenes a la tele que llegan tarde.
 *
 * Telegram guarda los mensajes mientras Asistenta está apagada y los entrega
 * todos al arrancar. Un «pausa» o «cierra la app» de hace media hora no debe
 * llegar a la tele justo cuando alguien abre Netflix: una orden a la tele de un
 * mensaje con más de STALE_TV_ORDER_MS no se ejecuta, y se dice claro.
 * Solo afecta a la tele; el resto de mensajes viejos se atienden igual.
 */

/** Edad a partir de la cual una orden a la tele ya no se ejecuta (2 min). */
export const STALE_TV_ORDER_MS = 2 * 60_000;

/**
 * Aviso si el mensaje que pide la orden es viejo; null si es reciente o si no
 * se sabe cuándo se envió (panel, voz, rutinas: siempre en vivo).
 */
export function staleTvOrderNotice(
  sentAt: string | undefined,
  now: number = Date.now(),
): string | null {
  if (!sentAt) return null;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return null;
  const age = now - sent;
  if (age <= STALE_TV_ORDER_MS) return null;
  const min = Math.round(age / 60_000);
  const when = min >= 60 ? `hace ${Math.round(min / 60)} h` : `hace ${min} min`;
  return `No he tocado la tele: esa orden es de un mensaje de ${when} que me llegó tarde (Asistenta estaba apagada). Si aún la quieres, repítela.`;
}
