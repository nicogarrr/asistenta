import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');

function fechas(text: string): string[] {
  return extractCommitments(
    [
      {
        id: 'm',
        from: 'equipo@example.com',
        to: [],
        subject: 'Reunión',
        text,
        at: NOW,
        seen: false,
        folder: 'INBOX',
      },
    ],
    { now: NOW, timeZone: 'Europe/Madrid', minConfidence: 0 },
  ).map((c) => new Date(c.at).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16));
}

describe('agenda del correo: «el 10-12%» es un porcentaje, no el 10 de diciembre', () => {
  it('un rango con % no se apunta como cita', () => {
    // Antes: 2026-12-10 09:00 en la agenda.
    expect(fechas('Reunión de resultados: prevemos crecer el 10-12% este año.')).toEqual([]);
    expect(fechas('Reunión de resultados: prevemos crecer el 10-12 % este año.')).toEqual([]);
  });

  it('las fechas de verdad siguen entrando', () => {
    expect(fechas('Reunión el 10-12 a las 9:00')).toEqual(['2026-12-10 09:00']);
    expect(fechas('Reunión el 10-12 a las 9:00 para hablar del 5% de subida')).toEqual([
      '2026-12-10 09:00',
    ]);
  });
});
