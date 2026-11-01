import type { Delivery, DeliveryStatus } from './deliveries.js';

/** Textos de repartos: el aviso de un cambio y la lista para «¿dónde está mi pedido?». */
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  confirmado: 'pedido confirmado',
  enviado: 'enviado',
  en_reparto: 'en reparto',
  para_recoger: 'listo para recoger',
  entregado: 'entregado',
  incidencia: 'incidencia',
  retrasado: 'con retraso',
};

function who(d: Delivery): string {
  const ref = d.tracking ?? d.orderRef;
  return `${d.carrier}${ref ? ` (${ref})` : ''}`;
}

/** «2026-11-02» del instante en la zona dada. */
function dayIn(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

export function formatDeliveryAlert(d: Delivery, now = Date.now(), timeZone?: string): string {
  if (d.status === 'en_reparto') {
    // «llega hoy» solo si salió a reparto hoy: un aviso que sale al día siguiente (el PC
    // estuvo apagado) no puede prometer «hoy».
    const day = dayIn(d.statusAt, timeZone);
    if (day === dayIn(now, timeZone))
      return `📦 Tu paquete de ${who(d)} está en reparto: llega hoy.`;
    const when =
      day === dayIn(now - 86_400_000, timeZone) || day === dayIn(now - 82_800_000, timeZone)
        ? 'ayer'
        : `el ${day.slice(8, 10)}/${day.slice(5, 7)}`;
    return `📦 Tu paquete de ${who(d)} salió a reparto ${when}: si no te ha llegado, mira el correo de la transportista.`;
  }
  if (d.status === 'para_recoger')
    return `📦 Tu paquete de ${who(d)} está listo para recoger: «${d.title}».`;
  if (d.status === 'entregado') return `📦 Tu paquete de ${who(d)} ya está entregado.`;
  if (d.status === 'retrasado')
    return `📦 Tu paquete de ${who(d)} va con retraso: la nueva fecha la dice el correo de la transportista.`;
  return `📦 Hay una incidencia con tu paquete de ${who(d)}: «${d.title}». Mira el correo de la transportista.`;
}

/** «¿Dónde está mi pedido?» */
export function deliveriesText(list: readonly Delivery[], timeZone?: string): string {
  if (list.length === 0) return 'No veo ningún envío en marcha en tu correo.';
  const fmt = new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  return list
    .slice(0, 10)
    .map(
      (d) =>
        `${who(d)}: ${DELIVERY_STATUS_LABEL[d.status]} (${fmt.format(new Date(d.statusAt))}) — ${d.title}`,
    )
    .join('\n');
}

/**
 * Paquetes para el resumen de la mañana: lo que sigue en camino (lo entregado ya no
 * es noticia). «notable» = en reparto, para recoger o con incidencia: eso sí justifica el resumen.
 */
export function briefingDeliveries(
  list: readonly Delivery[],
): Array<{ text: string; notable: boolean }> {
  return list
    .filter((d) => d.status !== 'entregado')
    .slice(0, 5)
    .map((d) => ({
      text: `${who(d)}: ${DELIVERY_STATUS_LABEL[d.status]}`,
      notable:
        d.status === 'en_reparto' ||
        d.status === 'para_recoger' ||
        d.status === 'incidencia' ||
        d.status === 'retrasado',
    }));
}
