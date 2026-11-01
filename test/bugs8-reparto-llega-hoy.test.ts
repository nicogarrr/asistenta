import { describe, expect, it } from 'vitest';
import type { Delivery } from '../src/mail/deliveries.js';
import { formatDeliveryAlert } from '../src/mail/deliveries-text.js';

// El aviso de un paquete «en reparto» decía siempre «llega hoy». Si el correo era de
// ayer (el PC estuvo apagado y el aviso sale al día siguiente), «hoy» era falso: el
// reparto fue ayer. Ahora dice cuándo salió a reparto.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-02T08:00:00Z').getTime(); // lunes 2 nov, 09:00 en Madrid

function parcel(statusAt: string): Delivery {
  return {
    key: 't:0261234567',
    carrier: 'MRW',
    tracking: '0261234567',
    orderRef: null,
    title: 'Tu envío está en reparto',
    status: 'en_reparto',
    statusAt: new Date(statusAt).getTime(),
    notified: null,
  } as Delivery;
}

describe('aviso de reparto: «llega hoy» solo si es de hoy', () => {
  it('de hoy: llega hoy', () => {
    expect(formatDeliveryAlert(parcel('2026-11-02T07:30:00Z'), NOW, TZ)).toBe(
      '📦 Tu paquete de MRW (0261234567) está en reparto: llega hoy.',
    );
  });

  it('de ayer: salió a reparto ayer', () => {
    expect(formatDeliveryAlert(parcel('2026-11-01T17:00:00Z'), NOW, TZ)).toBe(
      '📦 Tu paquete de MRW (0261234567) salió a reparto ayer: si no te ha llegado, mira el correo de la transportista.',
    );
  });

  it('de antes: con la fecha', () => {
    expect(formatDeliveryAlert(parcel('2026-10-31T09:00:00Z'), NOW, TZ)).toBe(
      '📦 Tu paquete de MRW (0261234567) salió a reparto el 31/10: si no te ha llegado, mira el correo de la transportista.',
    );
  });
});
