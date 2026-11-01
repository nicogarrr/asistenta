import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { MailMessage } from '../src/mail/types.js';
import { formatChargeAlerts, ingestCharges, pendingChargeAlerts } from '../src/ojo-charges.js';

const H = 3_600_000;
const BASE = new Date('2026-10-28T10:00:00+01:00').getTime();
const mail = (id: string, subject: string, text: string, at: number): MailMessage =>
  ({ id, from: 'Tienda <pedidos@tienda.es>', subject, text, at }) as unknown as MailMessage;

/** Siembra: un primer correo antiguo para que la tienda no salga como «primer cargo». */
function rig() {
  const db = new DatabaseSync(':memory:');
  ingestCharges(db, [mail('s0', 'Recibo de tu compra', 'Importe: 9,99 €', BASE - 400 * H)], BASE);
  return db;
}
const pedido = (n: string, at: number): MailMessage =>
  mail(n, `Recibo del pedido ${n}: Correa Charge 6`, 'Importe: 24,99 €. Llega el viernes.', at);

describe('vigilante de cobros: posible pedido repetido', () => {
  it('mismo comercio, importe y asunto en menos de 48 h → aviso «repetido»', () => {
    const db = rig();
    ingestCharges(db, [pedido('4471', BASE + H), pedido('4472', BASE + 3 * H)], BASE + 4 * H);
    const alerts = pendingChargeAlerts(db, BASE + 4 * H);
    const rep = alerts.filter((a) => a.reason === 'repetido');
    expect(rep.map((a) => a.msgId)).toEqual(['4472']);
    const text = formatChargeAlerts(rep, 'Europe/Madrid');
    expect(text).toContain('24,99 €');
    expect(text).toContain('repetido');
  });

  it('si llegan en barridos distintos también lo ve', () => {
    const db = rig();
    ingestCharges(db, [pedido('a1', BASE + H)], BASE + 2 * H);
    ingestCharges(db, [pedido('a2', BASE + 30 * H)], BASE + 31 * H);
    expect(pendingChargeAlerts(db, BASE + 31 * H).map((a) => a.reason)).toContain('repetido');
  });

  it('no avisa si el asunto es otro (confirmación y factura del mismo pedido)', () => {
    const db = rig();
    ingestCharges(
      db,
      [
        mail('c1', 'Recibo del pedido 9001', 'Importe: 24,99 €', BASE + H),
        mail('c2', 'Tu factura de noviembre', 'Importe: 24,99 €', BASE + 2 * H),
      ],
      BASE + 3 * H,
    );
    expect(pendingChargeAlerts(db, BASE + 3 * H).map((a) => a.reason)).not.toContain('repetido');
  });

  it('no avisa pasadas 48 h (una suscripción mensual no es un pedido repetido)', () => {
    const db = rig();
    ingestCharges(db, [pedido('m1', BASE + H), pedido('m2', BASE + 60 * H)], BASE + 61 * H);
    expect(pendingChargeAlerts(db, BASE + 61 * H).map((a) => a.reason)).not.toContain('repetido');
  });

  it('no avisa de importes distintos ni en la primera siembra', () => {
    const db = rig();
    ingestCharges(
      db,
      [
        pedido('d1', BASE + H),
        mail('d2', 'Recibo del pedido d2: Correa Charge 6', 'Importe: 19,99 €', BASE + 2 * H),
      ],
      BASE + 3 * H,
    );
    expect(pendingChargeAlerts(db, BASE + 3 * H).map((a) => a.reason)).not.toContain('repetido');
    const seed = new DatabaseSync(':memory:');
    ingestCharges(seed, [pedido('e1', BASE - 3 * H), pedido('e2', BASE - 2 * H)], BASE);
    expect(pendingChargeAlerts(seed, BASE)).toEqual([]);
  });
});
