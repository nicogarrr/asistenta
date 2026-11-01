import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';
import { estimateDueAt } from '../src/alerts/due.js';

// Domingo 1 de noviembre de 2026, 11:00 en Madrid. El lunes 9 y el viernes 13 caen en noviembre.
const NOW = Date.parse('2026-11-01T10:00:00Z');
const madrid = (t: number): string =>
  new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);

function cita(text: string): string | undefined {
  const found = extractCommitments(
    [
      {
        id: 'm',
        from: 'clinica@example.com',
        to: [],
        subject: 'Su cita',
        text,
        at: NOW,
        seen: false,
        folder: 'INBOX',
      },
    ],
    { now: NOW, timeZone: 'Europe/Madrid', minConfidence: 0 },
  );
  return found[0] ? madrid(found[0].at) : undefined;
}

describe('«el lunes 9»: el día de la semana con su número es ese día, no el lunes que viene', () => {
  it('agenda del correo', () => {
    // Antes: 2026-11-02 (el lunes más cercano), una semana antes de la cita.
    expect(cita('Le confirmamos su cita el lunes 9 a las 10:00 en la clínica.')).toBe(
      '2026-11-09 10:00',
    );
    expect(cita('Su cita es el viernes 13 a las 18:00.')).toBe('2026-11-13 18:00');
    expect(cita('Te espero el miércoles, 11 a las 17:30.')).toBe('2026-11-11 17:30');
  });

  it('si el número no cuadra con el día de la semana, se queda como estaba (el día de la semana)', () => {
    // El 10 de noviembre es martes: no se inventa otro mes.
    expect(cita('Reunión el lunes 10 a las 9:00.')).toBe('2026-11-02 09:00');
  });

  it('una hora pegada al día de la semana no es un número de día', () => {
    expect(cita('Reunión el lunes 10:00 en la oficina.')).toBe('2026-11-02 10:00');
  });

  it('seguimientos de promesas', () => {
    // Antes: 2026-11-02 11:00.
    expect(madrid(estimateDueAt('voy a ir al dentista el lunes 9', NOW))).toBe('2026-11-09 11:00');
    expect(madrid(estimateDueAt('tengo que pagar el seguro el viernes 13', NOW))).toBe(
      '2026-11-13 11:00',
    );
    expect(madrid(estimateDueAt('tengo que llamar el lunes 10', NOW))).toBe('2026-11-02 11:00');
    expect(madrid(estimateDueAt('voy a pagar el seguro el lunes', NOW))).toBe('2026-11-02 11:00');
  });
});
