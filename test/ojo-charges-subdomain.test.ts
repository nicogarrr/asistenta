import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { MailMessage } from '../src/mail/types.js';
import {
  ingestCharges,
  pendingChargeAlerts,
  registrableDomain,
  senderKey,
} from '../src/ojo-charges.js';

const H = 3_600_000;
const BASE = new Date('2026-10-01T10:00:00+02:00').getTime();
const mail = (id: string, from: string, text: string, at: number): MailMessage =>
  ({ id, from, subject: 'Cargo en tu tarjeta', text, at }) as unknown as MailMessage;

describe('vigilante de cobros: los subdominios de un comercio son el mismo remitente', () => {
  it('senderKey agrupa email./mail./info. bajo el dominio registrable', () => {
    expect(senderKey('Amazon <no-reply@email.amazon.es>')).toBe('amazon.es');
    expect(senderKey('pedidos@amazon.es')).toBe('amazon.es');
    expect(senderKey('Netflix <info@mailer.netflix.com>')).toBe('netflix.com');
    expect(senderKey('x@notify.amazon.co.uk')).toBe('amazon.co.uk');
    expect(senderKey('x@pagos.bbva.com.mx')).toBe('bbva.com.mx');
  });

  it('los correos gratuitos siguen siendo por dirección', () => {
    expect(senderKey('Ana <ana@gmail.com>')).toBe('ana@gmail.com');
    expect(senderKey('luis@hotmail.co.uk')).toBe('luis@hotmail.co.uk');
  });

  it('un dominio ajeno que imita al comercio no se agrupa con él', () => {
    expect(registrableDomain('amazon.es.cobros-raros.io')).toBe('cobros-raros.io');
    expect(registrableDomain('Amazon.ES.')).toBe('amazon.es');
  });

  it('un cobro desde email.amazon.es no da aviso «nuevo» si amazon.es ya cobraba', () => {
    const db = new DatabaseSync(':memory:');
    const hist = [
      mail('a1', 'pedidos@amazon.es', 'Se ha cobrado 20,00 €', BASE - 72 * H),
      mail('a2', 'pedidos@amazon.es', 'Se ha cobrado 22,00 €', BASE - 48 * H),
    ];
    ingestCharges(db, hist, BASE);
    ingestCharges(
      db,
      [...hist, mail('a3', 'Amazon <no-reply@email.amazon.es>', 'Se ha cobrado 21,00 €', BASE + H)],
      BASE + 2 * H,
    );
    expect(pendingChargeAlerts(db, BASE + 2 * H)).toEqual([]);
  });

  it('historial guardado antes del cambio («email.amazon.es») cuenta para amazon.es', () => {
    const db = new DatabaseSync(':memory:');
    ingestCharges(db, [], BASE);
    const ins = db.prepare(
      "INSERT INTO vigilante_charges (msg_id, sender, cents, at, status, reason, median_cents, n_prior, created_at) VALUES (?, 'email.amazon.es', 2000, ?, 'base', NULL, NULL, 0, ?)",
    );
    ins.run('old1', BASE - 72 * H, BASE);
    ins.run('old2', BASE - 48 * H, BASE);
    ingestCharges(
      db,
      [mail('n1', 'pedidos@amazon.es', 'Se ha cobrado 20,50 €', BASE + H)],
      BASE + 2 * H,
    );
    expect(pendingChargeAlerts(db, BASE + 2 * H)).toEqual([]);
  });

  it('un remitente de verdad nuevo sigue avisando', () => {
    const db = new DatabaseSync(':memory:');
    ingestCharges(
      db,
      [mail('a1', 'pedidos@amazon.es', 'Se ha cobrado 20,00 €', BASE - 48 * H)],
      BASE,
    );
    ingestCharges(
      db,
      [mail('r1', 'cobros@raro.io', 'Se ha cobrado 9,99 €', BASE + H)],
      BASE + 2 * H,
    );
    expect(pendingChargeAlerts(db, BASE + 2 * H).map((a) => a.reason)).toEqual(['nuevo']);
  });
});
