import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

const TZ = 'Europe/Madrid';

function dates(text: string, nowIso: string): string[] {
  return extractCommitments(
    [{ id: 'm1', from: 'citas@clinica.es', subject: 'Cita', text } as never],
    { now: Date.parse(nowIso), timeZone: TZ, minConfidence: 0 },
  ).map((c) => new Date(c.at).toISOString());
}

describe('agenda/extract: «el 3-12» sin año, con guion', () => {
  it('«la reunión es el 3-12 a las 18:00» es el 3 de diciembre', () => {
    expect(dates('La reunión es el 3-12 a las 18:00', '2026-11-01T10:00:00Z')).toEqual([
      '2026-12-03T17:00:00.000Z',
    ]);
  });

  it('«el 20-11 a las 9:30» también', () => {
    expect(dates('Tienes cita con el médico el 20-11 a las 9:30', '2026-11-01T10:00:00Z')).toEqual([
      '2026-11-20T08:30:00.000Z',
    ]);
  });

  it('un rango o un porcentaje no son fechas', () => {
    expect(dates('Reunión de padres: niños de 3-12 años', '2026-11-01T10:00:00Z')).toEqual([]);
    expect(
      dates('La reunión confirmó que el 10-12 por ciento de la cuota sube', '2026-11-01T10:00:00Z'),
    ).toEqual([]);
  });

  it('con año sigue igual', () => {
    expect(dates('Tu cita es el 10-01-2027 a las 10:00', '2026-11-01T10:00:00Z')).toEqual([
      '2027-01-10T09:00:00.000Z',
    ]);
  });
});
