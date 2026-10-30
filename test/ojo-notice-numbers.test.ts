import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AgendaItem } from '../src/agenda/unified.js';
import {
  confirmNotices,
  dismissNotice,
  dropStaleReservations,
  lastNoticeNumber,
  releaseNotices,
  reserveNotices,
} from '../src/ojo-ignore.js';

const item = (title: string): AgendaItem => ({
  title,
  at: Date.UTC(2026, 10, 2, 9),
  kind: 'deadline',
  where: 'correo',
  timed: true,
});

describe('números de aviso: uno huérfano nunca se reutiliza', () => {
  it('soltar un envío fallido no rebaja la secuencia por debajo de una reserva huérfana', () => {
    const db = new DatabaseSync(':memory:');
    confirmNotices(db, reserveNotices(db, [item('Factura luz')], 1)); // #1 enviado
    // #2 se reservó, el proceso murió con el envío en vuelo: quizá llegó a salir.
    expect(reserveNotices(db, [item('Factura agua')], 2)).toEqual([2]);
    dropStaleReservations(db);
    // Siguiente barrido: #3 falla y se suelta.
    const failed = reserveNotices(db, [item('Factura gas')], 3);
    expect(failed).toEqual([3]);
    releaseNotices(db, failed);
    expect(lastNoticeNumber(db)).toBe(2);
    // El reintento NO puede volver a usar el #2 (el mensaje huérfano quizá lo mostró).
    const retry = reserveNotices(db, [item('Factura gas')], 4);
    expect(retry).toEqual([3]);
    confirmNotices(db, retry);
    expect(dismissNotice(db, 2, 5)).toMatchObject({ ok: false });
  });

  it('un envío fallido sigue reutilizando sus propios números', () => {
    const db = new DatabaseSync(':memory:');
    confirmNotices(db, reserveNotices(db, [item('A uno')], 1));
    const ns = reserveNotices(db, [item('B dos'), item('C tres')], 2);
    expect(ns).toEqual([2, 3]);
    releaseNotices(db, ns);
    expect(lastNoticeNumber(db)).toBe(1);
    expect(reserveNotices(db, [item('B dos')], 3)).toEqual([2]);
  });

  it('nunca baja de un número ya descartado ni de uno enviado', () => {
    const db = new DatabaseSync(':memory:');
    const sent = reserveNotices(db, [item('A uno'), item('B dos')], 1);
    confirmNotices(db, sent);
    dismissNotice(db, 2, 2);
    const ns = reserveNotices(db, [item('C tres')], 3);
    releaseNotices(db, ns);
    expect(lastNoticeNumber(db)).toBe(2);
    releaseNotices(db, []);
    expect(lastNoticeNumber(db)).toBe(2);
  });
});
