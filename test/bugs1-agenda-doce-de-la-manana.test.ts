import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// asis-bugs-1: «a las 12 de la mañana» (mediodía en España) se apuntaba en la agenda a
// las 00:00, doce horas antes de la cita.
const now = Date.UTC(2026, 10, 1, 9, 0); // domingo 1 nov 2026, 10:00 en Madrid
const hora = (text: string) => {
  const [hit] = extractCommitments(
    [{ id: '1', subject: '', text, from: 'citas@clinica.es' }] as never,
    {
      now,
      timeZone: 'Europe/Madrid',
      minConfidence: 0,
    },
  );
  return hit
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Madrid',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(hit.at))
    : null;
};

describe('agenda: las 12 de la mañana es mediodía', () => {
  it('«a las 12 de la mañana» es a las 12:00', () => {
    expect(hora('Reunión mañana a las 12 de la mañana')).toBe('2026-11-02 12:00');
    expect(hora('Tu cita con el dentista es el 5 de noviembre a las 12 de la mañana')).toBe(
      '2026-11-05 12:00',
    );
  });

  it('las demás horas no cambian', () => {
    expect(hora('Cita el 5 de noviembre a las 9 de la mañana')).toBe('2026-11-05 09:00');
    expect(hora('Cita el 5 de noviembre a las 12 de la madrugada')).toBe('2026-11-05 00:00');
    expect(hora('Cita el 10 de noviembre a las 9 de la noche')).toBe('2026-11-10 21:00');
  });
});
