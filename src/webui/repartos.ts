import type { Delivery } from '../mail/deliveries.js';
import { DELIVERY_STATUS_LABEL } from '../mail/deliveries-text.js';

export interface PanelReparto {
  envio: string;
  estado: string;
  cuando: string;
  titulo: string;
  /** Número de seguimiento o de pedido, aparte para poder copiarlo. */
  seguimiento?: string;
}

/**
 * Tarjeta «Paquetes» del panel: lo que se sabe de los correos de envío, solo lectura.
 * Nunca enlaces ni datos de la web de la transportista: solo lo que ya dijo el correo.
 */
export function panelRepartos(
  list: readonly Delivery[],
  timeZone?: string,
): { repartos: PanelReparto[] } {
  const fmt = new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
  return {
    repartos: list.slice(0, 20).map((d) => {
      const ref = d.tracking ?? d.orderRef;
      return {
        envio: d.carrier,
        estado: DELIVERY_STATUS_LABEL[d.status],
        cuando: fmt.format(new Date(d.statusAt)),
        titulo: d.title,
        ...(ref ? { seguimiento: ref } : {}),
      };
    }),
  };
}
