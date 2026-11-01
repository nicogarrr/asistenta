import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  ParcelCheckIn,
  parcelAnswerReply,
  parcelCheckInAt,
  pickParcelCheckIn,
} from '../src/daemon/parcel-checkin.js';
import { activeDeliveries, type Delivery, initDeliveryStore } from '../src/mail/deliveries.js';

/**
 * Como Tab: un paquete «en reparto» llega hoy. Si por la noche sigue sin «entregado»,
 * una sola pregunta: «¿Te llegó el paquete de InPost?». Reloj falso, base en memoria.
 */
const TZ = 'Europe/Madrid';
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, day, hour, minute).getTime();

function parcel(over: Partial<Delivery> = {}): Delivery {
  return {
    key: 't:ABC123',
    carrier: 'InPost',
    tracking: 'ABC123',
    orderRef: null,
    title: 'Tu paquete está en reparto',
    status: 'en_reparto',
    statusAt: at(30, 9),
    notified: 'en_reparto',
    ...over,
  };
}

function dbWith(...list: Delivery[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initDeliveryStore(db);
  const ins = db.prepare(
    'INSERT INTO deliveries (key, carrier, tracking, order_ref, title, status, status_at, notified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const d of list)
    ins.run(
      d.key,
      d.carrier,
      d.tracking,
      d.orderRef,
      d.title,
      d.status,
      d.statusAt,
      d.notified,
      d.statusAt,
    );
  return db;
}

function checker(db: DatabaseSync, clock: { now: number }, quiet = false) {
  const sent: string[] = [];
  const c = new ParcelCheckIn({
    db,
    send: async (text) => {
      sent.push(text);
      return true;
    },
    now: () => clock.now,
    quiet: () => quiet,
    enabled: () => true,
    timeZone: () => TZ,
  });
  return { c, sent };
}

describe('cuándo se pregunta por un paquete en reparto', () => {
  it('a las 21:00 del día del reparto, o 3 h después si salió tarde', () => {
    expect(parcelCheckInAt(at(30, 9), TZ)).toBe(at(30, 21));
    expect(parcelCheckInAt(at(30, 20), TZ)).toBe(at(30, 23));
  });

  it('solo en reparto, ya pasada la hora, no viejo y no preguntado', () => {
    const never = () => false;
    expect(pickParcelCheckIn([parcel()], at(30, 20), never, TZ)).toBeNull();
    expect(pickParcelCheckIn([parcel()], at(30, 21, 5), never, TZ)?.key).toBe('t:ABC123');
    expect(pickParcelCheckIn([parcel({ status: 'entregado' })], at(30, 22), never, TZ)).toBeNull();
    expect(pickParcelCheckIn([parcel({ status: 'enviado' })], at(30, 22), never, TZ)).toBeNull();
    expect(pickParcelCheckIn([parcel()], at(30, 22), () => true, TZ)).toBeNull();
    expect(pickParcelCheckIn([parcel()], at(2 + 31, 10), never, TZ)).toBeNull();
  });
});

describe('la pregunta, una vez', () => {
  it('pregunta una sola vez y en corto', async () => {
    const clock = { now: at(30, 21, 10) };
    const { c, sent } = checker(dbWith(parcel()), clock);
    expect(await c.tick()).toBe(
      '¿Te llegó el paquete de InPost? Dime «sí» y lo doy por entregado.',
    );
    clock.now = at(30, 21, 20);
    expect(await c.tick()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('no repite tras reiniciar (lo preguntado queda en la base)', async () => {
    const db = dbWith(parcel());
    const clock = { now: at(30, 21, 10) };
    await checker(db, clock).c.tick();
    clock.now = at(30, 21, 40);
    const again = checker(db, clock);
    expect(await again.c.tick()).toBeNull();
    expect(again.sent).toHaveLength(0);
  });

  it('nada en horas de silencio; sale después', async () => {
    const db = dbWith(parcel());
    const clock = { now: at(30, 22, 30) };
    expect(await checker(db, clock, true).c.tick()).toBeNull();
    clock.now = at(31, 9);
    expect(await checker(db, clock).c.tick()).toContain('InPost');
  });

  it('sin transportista, nombra el asunto', async () => {
    const clock = { now: at(30, 21, 10) };
    const { c } = checker(
      dbWith(parcel({ carrier: 'tienda', title: 'Tu pedido de zapatillas' })),
      clock,
    );
    expect(await c.tick()).toContain('«Tu pedido de zapatillas»');
  });
});

describe('la respuesta', () => {
  it('«sí, ya lo tengo» lo marca como entregado', async () => {
    const db = dbWith(parcel());
    const clock = { now: at(30, 21, 10) };
    const { c } = checker(db, clock);
    await c.tick();
    expect(c.answered('Sí, ya lo tengo, gracias', at(30, 21, 30))).toBe('entregado');
    expect(activeDeliveries(db, at(30, 21, 31))[0]?.status).toBe('entregado');
    expect(parcelAnswerReply('entregado')).toBe('Genial, lo doy por entregado.');
  });

  it('«todavía no» lo deja en marcha', async () => {
    const db = dbWith(parcel());
    const clock = { now: at(30, 21, 10) };
    const { c } = checker(db, clock);
    await c.tick();
    expect(c.answered('todavía no', at(30, 21, 30))).toBe('no');
    expect(activeDeliveries(db, at(30, 21, 31))[0]?.status).toBe('en_reparto');
  });

  it('otra cosa, o sin pregunta, no se toma por respuesta', async () => {
    const db = dbWith(parcel());
    const clock = { now: at(30, 21, 10) };
    const { c } = checker(db, clock);
    expect(c.answered('sí', at(30, 21, 5))).toBeNull();
    await c.tick();
    expect(c.answered('pon la tele', at(30, 21, 30))).toBeNull();
    // ya habló de otra cosa: este «sí» no es para el paquete
    expect(c.answered('sí', at(30, 21, 31))).toBeNull();
    expect(activeDeliveries(db, at(30, 21, 32))[0]?.status).toBe('en_reparto');
  });

  it('pasadas 12 h, el «sí» ya no cuenta', async () => {
    const clock = { now: at(30, 21, 10) };
    const { c } = checker(dbWith(parcel()), clock);
    await c.tick();
    expect(c.answered('sí', at(31, 12))).toBeNull();
  });

  it('el daemon pregunta y escucha la respuesta', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('new ParcelCheckIn(');
    expect(cli).toContain('parcelCheckIn.answered(');
  });
});
