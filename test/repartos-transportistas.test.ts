import { describe, expect, it } from 'vitest';
import { type Delivery, parseDelivery } from '../src/mail/deliveries.js';
import { briefingDeliveries, formatDeliveryAlert } from '../src/mail/deliveries-text.js';

const mail = (from: string, subject: string, text = '') => ({ from, subject, text });

describe('repartos: más transportistas y «listo para recoger»', () => {
  it('reconoce InPost, Paack, Celeritas, Zeleris, Envialia, Tipsa, Mondial Relay y Vinted Go', () => {
    const cases: Array<[string, string]> = [
      ['InPost <noreply@inpost.es>', 'InPost'],
      ['Paack <hola@paack.co>', 'Paack'],
      ['Celeritas <avisos@celeritastransporte.com>', 'Celeritas'],
      ['Zeleris <info@zeleris.com>', 'Zeleris'],
      ['Envialia <no-reply@envialia.com>', 'Envialia'],
      ['TIPSA <avisos@tip-sa.com>', 'Tipsa'],
      ['Mondial Relay <noreply@mondialrelay.es>', 'Mondial Relay'],
      ['Vinted Go <no-reply@vintedgo.com>', 'Vinted Go'],
    ];
    for (const [from, carrier] of cases) {
      const p = parseDelivery(mail(from, 'Tu envío está en camino', 'Envío 0123456789AB'));
      expect(p?.carrier, from).toBe(carrier);
    }
  });

  it('«listo para recoger» en taquilla, punto o oficina es su propio estado', () => {
    const subjects = [
      'Tu paquete está listo para recoger en el Locker',
      'Tu envío está disponible para su recogida en la oficina',
      'Ya puedes recoger tu paquete en tu Punto Pack',
      'Your parcel is ready for pickup',
    ];
    for (const s of subjects) {
      expect(parseDelivery(mail('InPost <noreply@inpost.es>', s))?.status, s).toBe('para_recoger');
    }
    // Ya recogido sigue siendo entregado.
    expect(
      parseDelivery(mail('InPost <noreply@inpost.es>', 'Paquete recogido en el Locker'))?.status,
    ).toBe('entregado');
  });

  it('«llegará hoy» y «se entregará hoy» cuentan como en reparto', () => {
    for (const s of [
      'Tu pedido llegará hoy',
      'Su envío se entregará hoy',
      'Su paquete será entregado hoy',
      'Entrega prevista hoy',
    ]) {
      expect(parseDelivery(mail('SEUR <no-reply@seur.com>', s))?.status, s).toBe('en_reparto');
    }
  });

  it('el aviso y el resumen dicen que hay que ir a por él', () => {
    const d: Delivery = {
      key: 't:X1',
      carrier: 'InPost',
      tracking: '0123456789AB',
      orderRef: null,
      title: 'Tu paquete está listo para recoger en el Locker Calle Mayor 3',
      status: 'para_recoger',
      statusAt: Date.now(),
      notified: null,
    };
    expect(formatDeliveryAlert(d)).toMatch(/listo para recoger.*Calle Mayor 3/);
    expect(briefingDeliveries([d])).toEqual([
      { text: 'InPost (0123456789AB): listo para recoger', notable: true },
    ]);
  });
});
