import { describe, expect, it } from 'vitest';
import { estimateDueAt, hasDateSignal } from '../src/alerts/due.js';
import { followupFromMessage } from '../src/cli.js';

// Domingo 1 de noviembre de 2026, 10:00 en Madrid.
const NOW = Date.parse('2026-11-01T09:00:00Z');
const madrid = (t: number): string =>
  new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
const due = (s: string, now = NOW): string => madrid(estimateDueAt(s, now));

describe('seguimientos: «a finales de mes», «a principios de diciembre», «dentro de un año»', () => {
  it('se apuntan (antes no contaban como fecha y la promesa no se seguía)', () => {
    for (const s of [
      'voy a pagar el alquiler a finales de mes',
      'voy a pagar el seguro a finales de diciembre',
      'voy a pedir cita a principios de diciembre',
      'voy a cambiar las ruedas a mediados de enero',
      'voy a renovar el pasaporte dentro de un año',
      'voy a cambiar de coche en dos años',
      'voy a renovar el dni el año que viene',
    ]) {
      expect(hasDateSignal(s), s).toBe(true);
      expect(followupFromMessage(s, NOW), s).not.toBeNull();
    }
  });

  it('con la fecha que dicen', () => {
    expect(due('voy a pagar el alquiler a finales de mes')).toBe('2026-11-30 10:00');
    expect(due('voy a pagar el seguro a finales de diciembre')).toBe('2026-12-31 10:00');
    expect(due('voy a pedir cita a principios de diciembre')).toBe('2026-12-01 10:00');
    expect(due('voy a cambiar las ruedas a mediados de enero')).toBe('2027-01-15 10:00');
    expect(due('voy a pagar a fin de febrero')).toBe('2027-02-28 10:00');
    // Octubre ya ha pasado: el del año que viene.
    expect(due('voy a pagar a finales de octubre')).toBe('2027-10-31 10:00');
    expect(due('voy a renovar el pasaporte dentro de un año')).toBe('2027-11-01 10:00');
    expect(due('voy a cambiar de coche en dos años')).toBe('2028-11-01 10:00');
    expect(due('voy a renovar el dni el año que viene')).toBe('2027-01-01 10:00');
  });

  it('a final del propio mes sigue siendo este mes', () => {
    const n29 = Date.parse('2026-11-29T09:00:00Z');
    expect(due('voy a pagar a finales de noviembre', n29)).toBe('2026-11-30 10:00');
  });

  it('lo de siempre sigue igual', () => {
    expect(due('voy a pagar el alquiler a fin de mes')).toBe('2026-11-30 10:00');
    expect(due('voy a pagar el seguro el 1 de diciembre')).toBe('2026-12-01 10:00');
    expect(hasDateSignal('tengo dos años de experiencia')).toBe(false);
  });
});
