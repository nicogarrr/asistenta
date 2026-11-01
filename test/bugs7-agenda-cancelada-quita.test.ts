import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';
import type { MailMessage } from '../src/mail/types.js';

// Un correo cancelaba una cita que ya estaba apuntada por un correo anterior: el de la
// cancelación ya no se apuntaba (#1659), pero la cita del primero seguía en la agenda y
// llegaba el aviso. Ahora la cancelación del mismo remitente para ese día la quita.
const now = Date.parse('2026-11-01T09:00:00Z'); // domingo 1 nov, 10:00 en Madrid
const DAY = 24 * 3600_000;

function mail(id: string, from: string, subject: string, text: string, at: number): MailMessage {
  return { id, from, to: [], subject, text, at, seen: false, folder: 'INBOX' };
}

const cita = mail(
  'a',
  'Clínica Dental <citas@clinica.es>',
  'Confirmación de su cita',
  'Le confirmamos su cita el 5 de noviembre a las 10:00 con la Dra. López.',
  now - 3 * DAY,
);

function titles(messages: MailMessage[]): string[] {
  return extractCommitments(messages, { now, timeZone: 'Europe/Madrid', minConfidence: 0 }).map(
    (c) => c.source.messageId,
  );
}

describe('agenda: una cancelación quita la cita ya apuntada', () => {
  it('sin cancelación la cita está', () => {
    expect(titles([cita])).toEqual(['a']);
  });

  it('la cancelación posterior del mismo remitente la quita', () => {
    const cancel = mail(
      'b',
      'citas@clinica.es',
      'Cita cancelada',
      'Se ha cancelado su cita del 5 de noviembre a las 10:00.',
      now - DAY,
    );
    expect(titles([cita, cancel])).toEqual([]);
    expect(titles([cancel, cita])).toEqual([]);
  });

  it('sin hora en la cancelación también vale para ese día', () => {
    const cancel = mail(
      'b',
      'citas@clinica.es',
      'Aviso',
      'Su cita del 5 de noviembre ha sido cancelada.',
      now - DAY,
    );
    expect(titles([cita, cancel])).toEqual([]);
  });

  it('otro remitente, otro día, otra hora o una cancelación anterior no la quitan', () => {
    const otro = mail(
      'b',
      'info@gimnasio.es',
      'Clase cancelada',
      'Se ha cancelado su clase del 5 de noviembre a las 10:00.',
      now - DAY,
    );
    const otroDia = mail(
      'c',
      'citas@clinica.es',
      'Cita cancelada',
      'Se ha cancelado su cita del 6 de noviembre a las 10:00.',
      now - DAY,
    );
    const otraHora = mail(
      'd',
      'citas@clinica.es',
      'Cita cancelada',
      'Se ha cancelado su cita del 5 de noviembre a las 17:00.',
      now - DAY,
    );
    const antes = mail(
      'e',
      'citas@clinica.es',
      'Cita cancelada',
      'Se ha cancelado su cita del 5 de noviembre a las 10:00.',
      now - 5 * DAY,
    );
    expect(titles([cita, otro, otroDia, otraHora, antes])).toEqual(['a']);
  });
});
