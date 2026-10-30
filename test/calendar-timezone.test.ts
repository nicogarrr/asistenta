import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CalendarEvent, parseIcs, summarizeForModel } from '../src/tools/calendar.js';

// La agenda se enseña en la hora de pared de PA_TIMEZONE, no en la del proceso:
// `pa` y cualquier llamada de librería no pasan por applyConfiguredTimeZone().
const saved = { TZ: process.env.TZ, PA: process.env.PA_TIMEZONE };

function restore(key: 'TZ' | 'PA_TIMEZONE', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function ev(
  id: string,
  startIso: string,
  endIso: string,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    summary: id,
    start: new Date(startIso),
    end: new Date(endIso),
    allDay: false,
    busy: true,
    ...extra,
  };
}

describe('agenda en PA_TIMEZONE con el proceso en otra zona', () => {
  beforeEach(() => {
    process.env.TZ = 'UTC';
    process.env.PA_TIMEZONE = 'Europe/Madrid';
  });
  afterEach(() => {
    restore('TZ', saved.TZ);
    restore('PA_TIMEZONE', saved.PA);
  });

  it('una reunión de las 09:00 en Madrid sale a las 09:00 +01:00, no 08:00 +00:00', () => {
    const out = summarizeForModel([ev('Reunión', '2026-11-05T08:00:00Z', '2026-11-05T09:00:00Z')]);
    expect(out).toContain('Times are local to Europe/Madrid (UTC+01:00).');
    expect(out).toContain('Thu 5 Nov 2026');
    expect(out).toContain('09:00-10:00 +01:00  Reunión');
  });

  it('las 23:30 UTC ya son el día siguiente en Madrid y cruzan medianoche (+1d)', () => {
    const out = summarizeForModel([ev('Tarde', '2026-11-05T22:30:00Z', '2026-11-05T23:30:00Z')]);
    expect(out).toContain('Thu 5 Nov 2026');
    expect(out).toContain('23:30-00:30 +01:00 (+1d)  Tarde');
    const late = summarizeForModel([
      ev('Madrugada', '2026-11-05T23:30:00Z', '2026-11-06T00:30:00Z'),
    ]);
    expect(late).toContain('Fri 6 Nov 2026');
    expect(late).toContain('00:30-01:30 +01:00  Madrugada');
  });

  it('en verano el desfase es +02:00', () => {
    const out = summarizeForModel([ev('Verano', '2026-07-01T07:00:00Z', '2026-07-01T08:00:00Z')]);
    expect(out).toContain('(UTC+02:00)');
    expect(out).toContain('09:00-10:00 +02:00  Verano');
  });

  it('un evento de día completo conserva su fecha', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:dia@test',
      'DTSTART;VALUE=DATE:20261107',
      'DTEND;VALUE=DATE:20261108',
      'SUMMARY:Puente',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const events = parseIcs(ics, new Date('2026-11-01T00:00:00Z'));
    const out = summarizeForModel(events);
    expect(out).toContain('Sat 7 Nov 2026');
    expect(out).toContain('all day  Puente');
  });
});

describe('sin PA_TIMEZONE sigue la zona del proceso', () => {
  afterEach(() => {
    restore('TZ', saved.TZ);
    restore('PA_TIMEZONE', saved.PA);
  });

  it('proceso en Madrid: mismo resultado de siempre', () => {
    process.env.TZ = 'Europe/Madrid';
    delete process.env.PA_TIMEZONE;
    const out = summarizeForModel([ev('Reunión', '2026-11-05T08:00:00Z', '2026-11-05T09:00:00Z')]);
    expect(out).toContain('Times are local to Europe/Madrid (UTC+01:00).');
    expect(out).toContain('09:00-10:00 +01:00  Reunión');
  });

  it('proceso en UTC: UTC', () => {
    process.env.TZ = 'UTC';
    delete process.env.PA_TIMEZONE;
    const out = summarizeForModel([ev('Reunión', '2026-11-05T08:00:00Z', '2026-11-05T09:00:00Z')]);
    expect(out).toContain('(UTC+00:00)');
    expect(out).toContain('08:00-09:00 +00:00  Reunión');
  });
});
