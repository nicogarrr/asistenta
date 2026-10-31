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
 * Aviso si el mensaje que pide la orden llegó tarde; null si llegó a tiempo o si
 * no se sabe cuándo se envió (panel, voz, rutinas: siempre en vivo).
 *
 * Cuenta lo que tardó en LLEGAR (receivedAt - sentAt), no lo que lleva esperando
 * en la cola del chat: un «pausa» recibido al momento detrás de un turno largo
 * sigue siendo una orden en vivo.
 */
export function staleTvOrderNotice(
  sentAt: string | undefined,
  receivedAt: string | number = Date.now(),
): string | null {
  if (!sentAt) return null;
  const sent = Date.parse(sentAt);
  const received = typeof receivedAt === 'number' ? receivedAt : Date.parse(receivedAt);
  if (!Number.isFinite(sent) || !Number.isFinite(received)) return null;
  const age = received - sent;
  if (age <= STALE_TV_ORDER_MS) return null;
  const min = Math.round(age / 60_000);
  const when = min >= 60 ? `hace ${Math.round(min / 60)} h` : `hace ${min} min`;
  return `No he tocado la tele: esa orden es de un mensaje de ${when} que me llegó tarde (Asistenta estaba apagada o sin conexión). Si aún la quieres, repítela.`;
}

/**
 * «Reprodúcelo en la tele» desde un mensaje que llegó tarde: el audio no va a la
 * tele (abrirlo puede cortar lo que se esté viendo). Se borra la copia, que si
 * no la borraba el propio cast al terminar.
 */
export function staleGuardedCaster<R extends { ok: boolean; message: string }>(
  cast: (file: string) => Promise<R>,
  staleOrder: () => string | null,
  remove: (file: string) => void,
): (file: string) => Promise<R | { ok: false; message: string }> {
  return async (file) => {
    const stale = staleOrder();
    if (!stale) return cast(file);
    remove(file);
    return { ok: false, message: stale };
  };
}
