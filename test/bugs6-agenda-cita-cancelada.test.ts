import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// Domingo 1 de noviembre de 2026, 10:00 en Madrid. Un correo que CANCELA una cita la
// apuntaba en la agenda como si fuera una cita nueva, y llegaba el aviso para ir.
const now = Date.parse('2026-11-01T10:00:00+01:00');
const madrid = (ms: number): string =>
  new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
const when = (text: string, subject = ''): string[] =>
  extractCommitments(
    [
      {
        id: '1',
        from: 'clinica@ejemplo.es',
        to: [],
        subject,
        text,
        at: now,
        seen: false,
        folder: 'INBOX',
      },
    ],
    { now, timeZone: 'Europe/Madrid' },
  ).map((c) => madrid(c.at));

describe('agenda: una cita cancelada no se apunta', () => {
  it('«se ha cancelado», «queda anulada», «ha sido cancelada», asunto «Cita cancelada»', () => {
    for (const t of [
      'Se ha cancelado su cita del 5 de noviembre a las 10:00.',
      'Su cita del 5 de noviembre a las 10:00 queda anulada.',
      'La reunión del jueves 5 de noviembre a las 10:00 ha sido cancelada.',
      'Lamentamos informarle de la cancelación de su cita del 5 de noviembre a las 10:00.',
      'Your appointment on November 5 at 10:00 has been cancelled.',
    ])
      expect(when(t), t).toEqual([]);
    expect(when('Le esperábamos el 5 de noviembre a las 10:00.', 'Cita cancelada')).toEqual([]);
  });

  it('una cita normal que menciona cómo cancelar sí se apunta', () => {
    expect(
      when(
        'Su cita es el 5 de noviembre a las 10:00. Si no puede venir, puede cancelarla en la web. Las citas no anuladas con 24 h de antelación se cobrarán.',
      ),
    ).toEqual(['2026-11-05 10:00']);
  });

  it('cancelada pero con nueva fecha: vale la nueva', () => {
    expect(
      when('Se ha cancelado su cita del 5 de noviembre. Nueva fecha: 12 de noviembre a las 9:30.'),
    ).toEqual(['2026-11-12 09:30']);
  });
});
