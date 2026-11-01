import { describe, expect, it } from 'vitest';
import { parseDelivery } from '../src/mail/deliveries.js';

// asis-bugs-1: «aún no ha sido entregado», «pendiente de ser entregado», «Entrega fallida»
// y «will be delivered today» se leían como ENTREGADO, y el paquete salía de los repartos
// activos sin haber llegado.
const status = (from: string, subject: string, text: string) =>
  parseDelivery({ from, subject, text })?.status ?? null;

describe('repartos: frases que dicen que aún NO se ha entregado', () => {
  it('una negación o un futuro delante de «entregado» no es entregado', () => {
    expect(
      status(
        'Correos <noreply@correos.es>',
        'Tu envío PQ4B6A0712345670128001',
        'Tu paquete aún no ha sido entregado.',
      ),
    ).not.toBe('entregado');
    expect(
      status(
        'MRW <x@mrw.es>',
        'Tu envío',
        'Está pendiente de ser entregado. Nº de envío 0123456789',
      ),
    ).not.toBe('entregado');
    expect(
      status(
        'UPS <x@ups.com>',
        'Update',
        'Your package has not been delivered yet. 1Z999AA10123456784',
      ),
    ).not.toBe('entregado');
  });

  it('una entrega fallida es una incidencia', () => {
    expect(
      status(
        'GLS <x@gls.es>',
        'Entrega fallida',
        'No ha sido entregado porque no había nadie en casa. Expedición 1234567890',
      ),
    ).toBe('incidencia');
  });

  it('«will be delivered today» es en reparto; «in 7-10 days» sigue enviado', () => {
    expect(
      status('DHL <x@dhl.com>', 'Your shipment will be delivered today', 'Waybill 1234567890'),
    ).toBe('en_reparto');
    expect(
      status(
        'AliExpress <x@aliexpress.com>',
        'Your order has shipped',
        'Your package will be delivered in 7-10 days. Tracking: LP00123456789012',
      ),
    ).toBe('enviado');
  });

  it('las entregas de verdad siguen siendo entregado', () => {
    expect(
      status(
        'Amazon.es <envios@amazon.es>',
        'Entregado: "Cable USB"',
        'Pedido 405-1234567-1234567',
      ),
    ).toBe('entregado');
    expect(
      status(
        'SEUR <x@seur.com>',
        'Tu envío',
        'Tu paquete ha sido entregado. Seguimiento 12345678901',
      ),
    ).toBe('entregado');
    expect(
      status(
        'Correos <x@correos.es>',
        'Tu envío',
        'Tu paquete se ha entregado. PQ4B6A0712345670128001',
      ),
    ).toBe('entregado');
    expect(
      status('DHL <x@dhl.com>', 'Your shipment has been delivered', 'Waybill 1234567890'),
    ).toBe('entregado');
    expect(
      status('InPost <x@inpost.es>', 'Paquete recogido en el locker', 'Código 123456789'),
    ).toBe('entregado');
  });
});
