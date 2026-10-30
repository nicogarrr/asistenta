import { describe, expect, it } from 'vitest';
import { estimateDueAt, hasDateSignal } from '../src/alerts/due.js';
import { followupFromMessage } from '../src/cli.js';

/**
 * Due dates for follow-ups. Instants are built from LOCAL parts: the suite pins
 * TZ=Europe/Madrid and the estimator works on the local calendar.
 */
const local = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

/** Martes 6 de octubre de 2026, 12:00. */
const TUESDAY = local(2026, 10, 6);
/** Lunes 5 de octubre de 2026, 12:00. */
const MONDAY = local(2026, 10, 5);

describe('estimateDueAt: a named calendar day is that day, not "a week from now"', () => {
  it('«antes del 8» said on the 6th is the 8th (it used to be the 13th, after the deadline)', () => {
    expect(estimateDueAt('pagar el seguro antes del 8', TUESDAY)).toBe(local(2026, 10, 8));
  });

  it('a day of the month already gone this month is next month', () => {
    expect(estimateDueAt('pagar el seguro antes del 2', TUESDAY)).toBe(local(2026, 11, 2));
    expect(estimateDueAt('el día 6 llamo', TUESDAY)).toBe(local(2026, 10, 6));
  });

  it('skips months that do not have that day', () => {
    expect(estimateDueAt('lo entrego el 31', local(2026, 9, 5))).toBe(local(2026, 10, 31));
    expect(estimateDueAt('lo entrego el 31', local(2026, 11, 5))).toBe(local(2026, 12, 31));
    expect(estimateDueAt('lo entrego el 31', local(2026, 12, 31, 9))).toBe(local(2026, 12, 31, 9));
  });

  it('reads dd/mm and dd/mm/yyyy, rolling to next year once the date has gone by', () => {
    expect(estimateDueAt('vence el 15/11', TUESDAY)).toBe(local(2026, 11, 15));
    expect(estimateDueAt('vence el 3/2', TUESDAY)).toBe(local(2027, 2, 3));
    expect(estimateDueAt('vence el 15/11/2027', TUESDAY)).toBe(local(2027, 11, 15));
    expect(estimateDueAt('vence el 15/11/27', TUESDAY)).toBe(local(2027, 11, 15));
  });

  it('reads «N de <mes>»', () => {
    expect(estimateDueAt('la cita es el 3 de noviembre', TUESDAY)).toBe(local(2026, 11, 3));
    expect(estimateDueAt('renovar antes del 1 de enero', TUESDAY)).toBe(local(2027, 1, 1));
    expect(estimateDueAt('renovar el 6 de octubre', TUESDAY)).toBe(TUESDAY);
  });

  it('an impossible date falls back to a week instead of inventing one', () => {
    expect(estimateDueAt('vence el 31/11', TUESDAY)).toBe(TUESDAY + 7 * 86_400_000);
    expect(estimateDueAt('vence el 30 de febrero', TUESDAY)).toBe(TUESDAY + 7 * 86_400_000);
  });
});

describe('estimateDueAt: weekdays and relative days', () => {
  it('«el lunes que viene» / «el próximo lunes» said on a Monday is next week', () => {
    expect(estimateDueAt('llamo al banco el lunes que viene', MONDAY)).toBe(local(2026, 10, 12));
    expect(estimateDueAt('llamo al banco el próximo lunes', MONDAY)).toBe(local(2026, 10, 12));
    // A bare weekday said that same day is today.
    expect(estimateDueAt('llamo al banco el lunes', MONDAY)).toBe(MONDAY);
    // «que viene» on another day is the coming one.
    expect(estimateDueAt('llamo al banco el viernes que viene', MONDAY)).toBe(local(2026, 10, 9));
  });

  it('«dentro de N días» and «en N semanas»', () => {
    expect(estimateDueAt('lo reviso dentro de 3 días', TUESDAY)).toBe(local(2026, 10, 9));
    expect(estimateDueAt('renuevo el pasaporte en 2 semanas', TUESDAY)).toBe(local(2026, 10, 20));
  });

  it('keeps the wall-clock time across the DST change (25-hour Sunday)', () => {
    const saturday = local(2026, 10, 24, 12);
    expect(estimateDueAt('lo hago mañana', saturday)).toBe(local(2026, 10, 25, 12));
    expect(estimateDueAt('lo hago pasado mañana', saturday)).toBe(local(2026, 10, 26, 12));
    expect(estimateDueAt('lo hago en 2 días', saturday)).toBe(local(2026, 10, 26, 12));
  });
});

describe('hasDateSignal', () => {
  it('accepts the new date shapes and still refuses a bare fraction', () => {
    expect(hasDateSignal('renuevo el pasaporte en 2 semanas')).toBe(true);
    expect(hasDateSignal('lo reviso dentro de 3 días')).toBe(true);
    expect(hasDateSignal('la cita es el 3 de noviembre')).toBe(true);
    expect(hasDateSignal('vence el 15/11')).toBe(true);
    expect(hasDateSignal('siempre tomo 1/2 pastilla')).toBe(false);
    expect(hasDateSignal('prefiero las reuniones por la mañana')).toBe(false);
  });
});

describe('followupFromMessage uses the same reading', () => {
  it('tracks «en 2 semanas» (the estimator knew weeks, the gate refused them)', () => {
    const hit = followupFromMessage('voy a renovar el pasaporte en 2 semanas', TUESDAY);
    expect(hit?.dueAt).toBe(local(2026, 10, 20));
  });

  it('a deadline before the default week is due on that day', () => {
    const hit = followupFromMessage('voy a pagar el seguro antes del 8', TUESDAY);
    expect(hit?.dueAt).toBe(local(2026, 10, 8));
  });
});
