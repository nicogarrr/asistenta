import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  type Delivery,
  ingestDeliveries,
  parseDelivery,
  pendingDeliveryAlerts,
} from '../src/mail/deliveries.js';
import { briefingDeliveries, formatDeliveryAlert } from '../src/mail/deliveries-text.js';
import type { MailMessage } from '../src/mail/types.js';

const mail = (
  from: string,
  subject: string,
  text = '',
  at = 1_762_000_000_000,
  id = subject,
): MailMessage => ({
  id,
  from,
  to: ['yo@example.com'],
  subject,
  text,
  at,
  seen: false,
  folder: 'INBOX',
});

describe('repartos: el aviso de retraso cuenta como «con retraso»', () => {
  it('reconoce el retraso en español y en inglés, en asunto y en cuerpo', () => {
    const cases: Array<[string, string]> = [
      ['Tu pedido lleva un retraso', ''],
      ['Sentimos el retraso de tu envío', ''],
      ['Tu paquete se retrasa', ''],
      ['La entrega se retrasará hasta el viernes', ''],
      ['Envío retrasado', ''],
      ['Información sobre tu pedido', 'Tu pedido ha sufrido una demora y llegará más tarde.'],
      ['Your package has been delayed', ''],
      ['There is a delay with your delivery', ''],
      ['Tu pedido llegará más tarde de lo previsto', ''],
    ];
    for (const [subject, text] of cases) {
      const p = parseDelivery(mail('Amazon <pedidos@amazon.es>', subject, text));
      expect(p?.status, subject).toBe('retrasado');
    }
  });

  it('una oferta para cambiar la entrega o un «sin retrasos» no son un retraso', () => {
    expect(
      parseDelivery(mail('Amazon <pedidos@amazon.es>', 'Puedes retrasar la entrega si no estás')),
    ).toBeNull();
    expect(
      parseDelivery(mail('Amazon <pedidos@amazon.es>', 'Recíbelo mañana, sin retrasos')),
    ).toBeNull();
    expect(
      parseDelivery(
        mail(
          'Amazon <pedidos@amazon.es>',
          'Cómo retrasar una entrega',
          'Puedes retrasar el envío.',
        ),
      ),
    ).toBeNull();
  });

  it('un enviado al que llega el retraso avisa una vez y queda «con retraso»', () => {
    const db = new DatabaseSync(':memory:');
    const t0 = 1_762_000_000_000;
    ingestDeliveries(
      db,
      [
        mail(
          'pedidos@amazon.es',
          'Tu pedido ha sido enviado',
          'Seguimiento: AB123456789ES',
          t0,
          'm1',
        ),
      ],
      t0,
    );
    ingestDeliveries(
      db,
      [
        mail(
          'pedidos@amazon.es',
          'Tu pedido lleva un retraso',
          'Seguimiento: AB123456789ES',
          t0 + 3_600_000,
          'm2',
        ),
      ],
      t0 + 3_600_000,
    );
    const alerts = pendingDeliveryAlerts(db, t0 + 3_600_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.status).toBe('retrasado');
    expect(formatDeliveryAlert(alerts[0] as Delivery)).toContain('va con retraso');
    db.close();
  });

  it('el resumen de la mañana lo cuenta como noticia y lo nombra «con retraso»', () => {
    const d: Delivery = {
      key: 't:AB123456789ES',
      carrier: 'Amazon',
      tracking: 'AB123456789ES',
      orderRef: null,
      title: 'Tu pedido lleva un retraso',
      status: 'retrasado',
      statusAt: Date.now(),
      notified: null,
    };
    expect(briefingDeliveries([d])).toEqual([
      { text: 'Amazon (AB123456789ES): con retraso', notable: true },
    ]);
  });
});
