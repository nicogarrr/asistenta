import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  activeDeliveries,
  ingestDeliveries,
  markDeliveriesNotified,
  parseDelivery,
  pendingDeliveryAlerts,
} from '../src/mail/deliveries.js';
import type { MailMessage } from '../src/mail/types.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 30, 8);
let n = 0;
const mail = (from: string, subject: string, text: string, at: number): MailMessage => ({
  id: `m${++n}`,
  from,
  to: ['yo@example.com'],
  subject,
  text,
  at,
  seen: false,
  folder: 'INBOX',
});

describe('repartos leyendo correos de envío', () => {
  it('reconoce transportista, estado, seguimiento y pedido', () => {
    expect(
      parseDelivery(
        mail(
          'envios@seur.com',
          'Tu envío está en reparto',
          'Número de envío: 12345678901 llega hoy',
          0,
        ),
      ),
    ).toEqual({
      carrier: 'SEUR',
      status: 'en_reparto',
      tracking: '12345678901',
      title: 'Tu envío está en reparto',
    });
    const amz = parseDelivery(
      mail(
        'confirmar-envio@amazon.es',
        'Enviado: «Correa de reloj»',
        'Pedido n.º 405-1234567-7654321. Será entregado el jueves por MRW.',
        0,
      ),
    );
    expect(amz).toMatchObject({
      carrier: 'Amazon',
      status: 'enviado',
      order: '405-1234567-7654321',
    });
    expect(
      parseDelivery(
        mail(
          'info@correos.es',
          'Entregado',
          'Tu envío PQ4B6M0712345670128001V ha sido entregado',
          0,
        ),
      ),
    ).toMatchObject({
      carrier: 'Correos',
      status: 'entregado',
      tracking: 'PQ4B6M0712345670128001V',
    });
    expect(
      parseDelivery(
        mail(
          'noreply@gls-spain.es',
          'Intento de entrega',
          'Estabas ausente. Expedición 98765432',
          0,
        ),
      )?.status,
    ).toBe('incidencia');
    // Correos que no son de envíos: nada.
    expect(
      parseDelivery(mail('amigo@gmail.com', 'Cena del jueves', '¿Te viene bien el jueves?', 0)),
    ).toBeNull();
    expect(
      parseDelivery(
        mail('news@tienda.com', 'Ofertas: envío gratis', 'Solo hoy envío gratis en todo', 0),
      ),
    ).toBeNull();
  });

  it('sigue un pedido de confirmado a entregado y avisa UNA vez por cambio real', () => {
    const db = new DatabaseSync(':memory:');
    const order = 'Pedido n.º 405-1234567-7654321';
    ingestDeliveries(db, [mail('pedidos@amazon.es', 'Pedido confirmado', order, T0)], T0);
    expect(pendingDeliveryAlerts(db, T0)).toEqual([]);
    ingestDeliveries(
      db,
      [
        mail(
          'envios@amazon.es',
          'Tu paquete ha salido',
          `${order}. Seguimiento: MRW 0261234567`,
          T0 + H,
        ),
      ],
      T0 + H,
    );
    let list = activeDeliveries(db, T0 + H);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: 'enviado',
      tracking: '0261234567',
      orderRef: '405-1234567-7654321',
    });
    expect(pendingDeliveryAlerts(db, T0 + H)).toEqual([]);

    const reparto = mail(
      'noreply@mrw.es',
      'Tu envío está en reparto',
      'Número de envío: 0261234567. Llega hoy.',
      T0 + 2 * H,
    );
    ingestDeliveries(db, [reparto], T0 + 2 * H);
    const alerts = pendingDeliveryAlerts(db, T0 + 2 * H);
    expect(alerts.map((d) => [d.carrier, d.tracking, d.status])).toEqual([
      ['Amazon', '0261234567', 'en_reparto'],
    ]);
    markDeliveriesNotified(db, alerts);
    // El mismo correo otra vez (siguiente barrido) no vuelve a avisar.
    ingestDeliveries(db, [reparto], T0 + 3 * H);
    expect(pendingDeliveryAlerts(db, T0 + 3 * H)).toEqual([]);

    ingestDeliveries(
      db,
      [mail('noreply@mrw.es', 'Entregado', 'Envío 0261234567 entregado', T0 + 4 * H)],
      T0 + 4 * H,
    );
    expect(pendingDeliveryAlerts(db, T0 + 4 * H).map((d) => d.status)).toEqual(['entregado']);
    list = activeDeliveries(db, T0 + 4 * H);
    expect(list.map((d) => d.tracking)).toEqual(['0261234567']);
    // A los tres días lo entregado sale de la lista.
    expect(activeDeliveries(db, T0 + 76 * H)).toEqual([]);
  });

  it('un correo viejo no pisa el estado ni avisa al leer el buzón por primera vez', () => {
    const db = new DatabaseSync(':memory:');
    const now = T0 + 10 * 24 * H;
    ingestDeliveries(
      db,
      [
        mail(
          'noreply@dhl.com',
          'Delivered',
          'Tracking: JD014600006281234567 delivered',
          T0 + 2 * H,
        ),
        mail('noreply@dhl.com', 'Out for delivery', 'Tracking: JD014600006281234567', T0 + H),
      ],
      now,
    );
    expect(activeDeliveries(db, T0 + 3 * H)[0]?.status).toBe('entregado');
    expect(pendingDeliveryAlerts(db, now)).toEqual([]);
  });
});
