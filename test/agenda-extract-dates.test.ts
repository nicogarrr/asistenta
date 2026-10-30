import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

const TZ = 'Europe/Madrid';

function dates(text: string, nowIso: string): string[] {
  return extractCommitments(
    [{ id: 'm1', from: 'citas@clinica.es', subject: 'Cita', text } as never],
    { now: Date.parse(nowIso), timeZone: TZ, minConfidence: 0 },
  ).map((c) => new Date(c.at).toISOString());
}

describe('agenda/extract: fechas numéricas día-mes', () => {
  it('«10/03» es 10 de marzo, no 3 de octubre', () => {
    expect(
      dates('Tu cita con el dentista es el 10/03 a las 10:00', '2027-02-01T10:00:00Z'),
    ).toEqual(['2027-03-10T09:00:00.000Z']);
  });

  it('«10-03-2027» también', () => {
    expect(dates('Tu cita es el 10-03-2027 a las 10:00', '2027-02-01T10:00:00Z')).toEqual([
      '2027-03-10T09:00:00.000Z',
    ]);
  });

  it('solo se da la vuelta cuando el segundo número no puede ser mes (03/13)', () => {
    expect(dates('Tu cita es el 03/13 a las 10:00', '2027-02-01T10:00:00Z')).toEqual([
      '2027-03-13T09:00:00.000Z',
    ]);
  });

  it('el ambiguo «03/10» sigue leyéndose día primero (3 de octubre)', () => {
    expect(dates('Tu cita es el 03/10 a las 10:00', '2026-09-01T10:00:00Z')).toEqual([
      '2026-10-03T08:00:00.000Z',
    ]);
  });
});

describe('agenda/extract: días que no existen', () => {
  it('«31 de febrero» no se convierte en 3 de marzo', () => {
    expect(dates('Tu cita es el 31 de febrero a las 10:00', '2027-02-01T10:00:00Z')).toEqual([]);
    expect(dates('Tu cita es el 31/02 a las 10:00', '2027-02-01T10:00:00Z')).toEqual([]);
  });

  it('el 29 de febrero vale en año bisiesto', () => {
    expect(
      dates('Tu cita es el 29 de febrero de 2028 a las 10:00', '2028-02-01T10:00:00Z'),
    ).toEqual(['2028-02-29T09:00:00.000Z']);
  });
});

describe('agenda/extract: fecha sin año alrededor de Año Nuevo', () => {
  it('«5 de enero» leído el 20 de diciembre es el enero que viene', () => {
    expect(dates('Tu cita es el 5 de enero a las 10:00', '2026-12-20T10:00:00Z')).toEqual([
      '2027-01-05T09:00:00.000Z',
    ]);
  });

  it('«05/01» y «enero 5» igual', () => {
    expect(dates('Tu cita es el 05/01 a las 10:00', '2026-12-20T10:00:00Z')).toEqual([
      '2027-01-05T09:00:00.000Z',
    ]);
    expect(dates('Tu reserva: enero 5 a las 10:00', '2026-12-20T10:00:00Z')).toEqual([
      '2027-01-05T09:00:00.000Z',
    ]);
  });

  it('«28 de diciembre» leído el 3 de enero ya pasó: no aparece', () => {
    expect(dates('Tu cita fue el 28 de diciembre a las 10:00', '2027-01-03T10:00:00Z')).toEqual([]);
  });

  it('una fecha de este año que ya pasó hace días sigue sin aparecer', () => {
    expect(dates('Tu cita era el 28 de octubre a las 10:00', '2026-10-30T10:00:00Z')).toEqual([]);
  });
});
