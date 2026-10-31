import type { Delivery, DeliveryStatus } from './deliveries.js';

/** Textos de repartos: el aviso de un cambio y la lista para «¿dónde está mi pedido?». */
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> = {
  confirmado: 'pedido confirmado',
  enviado: 'enviado',
  en_reparto: 'en reparto',
  entregado: 'entregado',
  incidencia: 'incidencia',
};

function who(d: Delivery): string {
  const ref = d.tracking ?? d.orderRef;
  return `${d.carrier}${ref ? ` (${ref})` : ''}`;
}

export function formatDeliveryAlert(d: Delivery): string {
  if (d.status === 'en_reparto') return `📦 Tu paquete de ${who(d)} está en reparto: llega hoy.`;
  if (d.status === 'entregado') return `📦 Tu paquete de ${who(d)} ya está entregado.`;
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
