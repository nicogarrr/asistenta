import { describe, expect, it } from 'vitest';
import { calendarioCortado, SOURCE_MAX_BYTES } from '../src/mail/invitacion-grande.js';

// bugs-38: si el corte de 32 KB cae DENTRO del .ics (el HTML de Outlook ocupa casi todo y el
// calendario empieza justo antes del corte), la fuente cortada traía un BEGIN:VEVENT a medias:
// calendarioCortado creía que ya estaba entero y no bajaba la parte, y la invitación salía sin
// título/hora o no salía.
const ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:comite-42@fondo.example',
  'DTSTART;TZID=Europe/Madrid:20261120T093000',
  'DTEND;TZID=Europe/Madrid:20261120T103000',
  'SUMMARY:Comité de inversión',
  'LOCATION:Teams',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const STRUCT = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/html' },
    { part: '2', type: 'text/calendar', parameters: { method: 'REQUEST' } },
  ],
};
const fuente = (relleno: number) =>
  [
    'From: Ana <ana@fondo.example>',
    'Subject: Comité de inversión',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: text/html; charset=UTF-8',
    '',
    `<html><body>${'x'.repeat(relleno)}</body></html>`,
    '--MIX',
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST',
    '',
    ICS,
    '--MIX--',
    '',
  ].join('\r\n');

describe('bugs-38: .ics cortado a medias por el límite de 32 KB', () => {
  it('con el VEVENT a medias, baja la parte', () => {
    const full = fuente(0);
    // Relleno para que el corte caiga justo después de «BEGIN:VEVENT» y del UID.
    const hastaUid = full.indexOf('DTSTART');
    const relleno = SOURCE_MAX_BYTES - hastaUid;
    const larga = Buffer.from(fuente(relleno), 'utf8');
    const cut = larga.subarray(0, SOURCE_MAX_BYTES);
    expect(cut.toString('utf8')).toContain('BEGIN:VEVENT');
    expect(cut.toString('utf8')).not.toContain('END:VEVENT');
    expect(calendarioCortado(cut, STRUCT)).toEqual(['2']);
  });

  it('con el VEVENT entero dentro del corte, no baja nada (como antes)', () => {
    const full = Buffer.from(fuente(SOURCE_MAX_BYTES - 900), 'utf8');
    const cut = full.subarray(0, SOURCE_MAX_BYTES);
    expect(cut.toString('utf8')).toContain('END:VEVENT');
    expect(calendarioCortado(cut, STRUCT)).toEqual([]);
  });
});
