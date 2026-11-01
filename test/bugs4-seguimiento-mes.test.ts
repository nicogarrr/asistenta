import { describe, expect, it } from 'vitest';
import { estimateDueAt, hasDateSignal } from '../src/alerts/due.js';
import { followupFromMessage } from '../src/cli.js';

// Viernes 20 de noviembre de 2026, 11:00 en Madrid.
const NOW = Date.parse('2026-11-20T10:00:00Z');
const madrid = (t: number): string =>
  new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
const due = (s: string): string => madrid(estimateDueAt(s, NOW));

describe('seguimientos: promesas para «el mes que viene» o «dentro de un mes»', () => {
  it('se apuntan (antes no se reconocían como fecha y la promesa no se seguía)', () => {
    for (const s of [
      'voy a pagar el alquiler el mes que viene',
      'voy a pagar el seguro el próximo mes',
      'voy a renovar el pasaporte dentro de un mes',
      'voy a cambiar el aceite en dos meses',
      'voy a pagar el alquiler a fin de mes',
      'voy a pagar el seguro el 15 del mes que viene',
    ]) {
      expect(hasDateSignal(s), s).toBe(true);
      expect(followupFromMessage(s, NOW), s).not.toBeNull();
    }
  });

  it('con la fecha que dicen, no a los siete días', () => {
    expect(due('voy a pagar el alquiler el mes que viene')).toBe('2026-12-01 11:00');
    expect(due('voy a pagar el seguro el próximo mes')).toBe('2026-12-01 11:00');
    expect(due('voy a renovar el pasaporte dentro de un mes')).toBe('2026-12-20 11:00');
    expect(due('voy a cambiar el aceite en dos meses')).toBe('2027-01-20 11:00');
    expect(due('voy a pagar el seguro el 15 del mes que viene')).toBe('2026-12-15 11:00');
    // Antes «el 1 del mes que viene» caía en el 1 de este mes (o hoy).
    expect(due('voy a pagar el alquiler el 1 del mes que viene')).toBe('2026-12-01 11:00');
    expect(due('voy a pagar el alquiler a fin de mes')).toBe('2026-11-30 11:00');
  });

  it('«el 29/2» va al próximo año bisiesto, no a los siete días', () => {
    expect(due('tengo que llamar a Ana el 29/2')).toBe('2028-02-29 11:00');
  });

  it('un mes que no es una fecha no se apunta', () => {
    expect(hasDateSignal('este mes he ido tres veces al gimnasio')).toBe(false);
    expect(hasDateSignal('llevo un mes sin fumar')).toBe(false);
  });
});
