import { describe, expect, it } from 'vitest';
import { estimateDueAt, hasDateSignal } from '../src/alerts/due.js';
import { followupFromMessage } from '../src/cli.js';

// Domingo 1 y miércoles 4 de noviembre de 2026, 10:00 en Madrid.
const SUN = Date.parse('2026-11-01T09:00:00Z');
const WED = Date.parse('2026-11-04T09:00:00Z');
const madrid = (t: number): string =>
  new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
const due = (s: string, now: number): string => madrid(estimateDueAt(s, now));

// «este fin de semana», «esta semana», «en diciembre» no contaban como
// fecha: la promesa se quedaba sin seguimiento.
describe('seguimientos: «este fin de semana», «esta semana», «en diciembre»', () => {
  it('se apuntan', () => {
    for (const s of [
      'voy a terminar el informe este fin de semana',
      'voy a limpiar el garaje el finde',
      'voy a llamar a Ana el próximo fin de semana',
      'voy a terminar el informe esta semana',
      'voy a pagar el seguro en diciembre',
    ]) {
      expect(hasDateSignal(s), s).toBe(true);
      expect(followupFromMessage(s, WED), s).not.toBeNull();
    }
  });

  it('el fin de semana: el domingo', () => {
    expect(due('voy a terminar el informe este fin de semana', WED)).toBe('2026-11-08 10:00');
    expect(due('voy a limpiar el garaje el finde', WED)).toBe('2026-11-08 10:00');
    expect(due('voy a terminar el informe este fin de semana', SUN)).toBe('2026-11-01 10:00');
    expect(due('voy a llamar a Ana el próximo fin de semana', WED)).toBe('2026-11-15 10:00');
    expect(due('voy a llamar a Ana el fin de semana que viene', WED)).toBe('2026-11-15 10:00');
  });

  it('esta semana: el domingo; dicho en domingo, el de la semana que empieza', () => {
    expect(due('voy a terminar el informe esta semana', WED)).toBe('2026-11-08 10:00');
    expect(due('voy a terminar el informe esta semana', SUN)).toBe('2026-11-08 10:00');
  });

  it('en <mes>: el último día de ese mes, este año o el que viene', () => {
    expect(due('voy a pagar el seguro en diciembre', SUN)).toBe('2026-12-31 10:00');
    expect(due('voy a pagar el seguro en noviembre', SUN)).toBe('2026-11-30 10:00');
    expect(due('voy a renovar el coche en febrero', SUN)).toBe('2027-02-28 10:00');
    expect(due('voy a cambiar la caldera en octubre', SUN)).toBe('2027-10-31 10:00');
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(due('voy a pagar a finales de diciembre', SUN)).toBe('2026-12-31 10:00');
    expect(due('voy a pagar el 15 de diciembre', SUN)).toBe('2026-12-15 10:00');
    expect(due('voy a llamar el viernes', WED)).toBe('2026-11-06 10:00');
    expect(hasDateSignal('prefiero el café por la mañana')).toBe(false);
    expect(hasDateSignal('este mes he ido tres veces al gimnasio')).toBe(false);
  });

  it('lo ya pasado no se apunta', () => {
    for (const s of [
      'esta semana he ido tres veces al gimnasio',
      'el fin de semana fui a la playa',
      'en diciembre fui a Roma',
    ])
      expect(followupFromMessage(s, WED), s).toBeNull();
  });
});
