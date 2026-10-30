import { describe, expect, it } from 'vitest';
import { parseIcs } from '../src/tools/calendar.js';

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const NOW = new Date('2026-11-02T07:00:00Z');
const titles = (body: string) =>
  parseIcs(wrap(body), NOW).map((e) => `${e.summary}@${e.start.toISOString()}`);

describe('calendario: eventos cancelados', () => {
  it('un evento con STATUS:CANCELLED no aparece', () => {
    const body = [
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART:20261103T080000Z',
      'DTEND:20261103T090000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Cancelada',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART:20261103T100000Z',
      'DTEND:20261103T110000Z',
      'STATUS:CONFIRMED',
      'SUMMARY:Sigue',
      'END:VEVENT',
    ].join('\r\n');
    expect(titles(body)).toEqual(['Sigue@2026-11-03T10:00:00.000Z']);
  });

  it('una instancia cancelada de una serie (RECURRENCE-ID) desaparece; las demás siguen', () => {
    const body = [
      'BEGIN:VEVENT',
      'UID:serie',
      'DTSTART;TZID=Europe/Madrid:20261102T090000',
      'DTEND;TZID=Europe/Madrid:20261102T100000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:Semanal',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:serie',
      'RECURRENCE-ID;TZID=Europe/Madrid:20261109T090000',
      'DTSTART;TZID=Europe/Madrid:20261109T090000',
      'DTEND;TZID=Europe/Madrid:20261109T100000',
      'STATUS:CANCELLED',
      'SUMMARY:Semanal',
      'END:VEVENT',
    ].join('\r\n');
    expect(titles(body)).toEqual([
      'Semanal@2026-11-02T08:00:00.000Z',
      'Semanal@2026-11-16T08:00:00.000Z',
    ]);
  });

  it('una serie cancelada entera no deja ninguna instancia', () => {
    const body = [
      'BEGIN:VEVENT',
      'UID:s2',
      'DTSTART:20261102T080000Z',
      'DTEND:20261102T090000Z',
      'RRULE:FREQ=DAILY;COUNT=5',
      'STATUS:cancelled',
      'SUMMARY:Fuera',
      'END:VEVENT',
    ].join('\r\n');
    expect(titles(body)).toEqual([]);
  });
});
