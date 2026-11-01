import { describe, expect, it } from 'vitest';
import { estimateDueAt, hasDateSignal } from '../src/alerts/due.js';

// asis-bugs-2: las fechas con guion o punto («el 10-01-2027», «el 3-12») se leían como
// «el día 10 / el día 3 de este mes»: el aviso de la promesa salía meses antes de lo dicho.
// Domingo 1 de noviembre de 2026, 10:00 en Madrid.
const now = Date.UTC(2026, 10, 1, 9, 0);
const madrid = (at: number) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date(at));

describe('promesas con fecha escrita con guion o punto', () => {
  it('dd-mm-aaaa y dd.mm.aaaa como dd/mm/aaaa', () => {
    expect(madrid(estimateDueAt('te pago el 10-01-2027', now))).toBe('2027-01-10');
    expect(madrid(estimateDueAt('te lo mando el 10.01.2027', now))).toBe('2027-01-10');
    expect(madrid(estimateDueAt('te lo mando el 10/01/2027', now))).toBe('2027-01-10');
  });

  it('dd-mm sin año: el próximo', () => {
    expect(madrid(estimateDueAt('te llamo el 3-12', now))).toBe('2026-12-03');
  });

  it('cuenta como fecha', () => {
    expect(hasDateSignal('te pago el 10-01-2027')).toBe(true);
  });

  it('«el 15.» al final de la frase sigue siendo el día 15', () => {
    expect(madrid(estimateDueAt('te lo paso el 15.', now))).toBe('2026-11-15');
  });
});
