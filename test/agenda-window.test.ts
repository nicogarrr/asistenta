import { describe, expect, it, vi } from 'vitest';
import { loadCalendar } from '../src/agenda/ics.js';
import { readAgendaOverview } from '../src/agenda/overview.js';
import { buildAgenda, calendarDaysFor } from '../src/agenda/unified.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const TZ = 'Europe/Madrid';
/** Martes 20 de octubre de 2026, 10:00 en Madrid. */
const NOW = Date.parse('2026-10-20T08:00:00Z');

/** A real feed read by the real `loadCalendar`, so the window is the production one. */
function feed(...events: Array<[uid: string, startUtc: string, title: string]>): string {
  const rows = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//fixture//EN'];
  for (const [uid, start, title] of events) {
    rows.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTAMP:20261001T000000Z',
      `DTSTART:${start}`,
      `SUMMARY:${title}`,
      'END:VEVENT',
    );
  }
  rows.push('END:VCALENDAR', '');
  return rows.join('\r\n');
}

const ICS = feed(
  ['manana', '20261021T070000Z', 'Dentista mañana'],
  ['dia7', '20261027T110000Z', 'Revisión del coche día 7'],
);

const calendar = (days: number) =>
  loadCalendar({
    fetchText: async () => ICS,
    getUrl: async () => 'https://example.test/cal.ics',
    now: () => NOW,
    timeZone: TZ,
    days,
  });

describe('agenda window: the calendar is read as far as the agenda shows', () => {
  it('calendarDaysFor: today plus the agenda days, clamped like the agenda', () => {
    expect(calendarDaysFor(1)).toBe(2);
    expect(calendarDaysFor(7)).toBe(8);
    expect(calendarDaysFor()).toBe(8);
    expect(calendarDaysFor(9999)).toBe(61);
    expect(calendarDaysFor(0)).toBe(2);
  });

  it('«/agenda 1» shows tomorrow (it used to read only today from the calendar)', async () => {
    const asked: number[] = [];
    const text = await readAgendaOverview(
      {
        authorised: () => true,
        now: () => NOW,
        calendar: (days) => {
          asked.push(days);
          return calendar(days);
        },
        followups: () => [],
        routines: () => '',
        goals: () => [],
      },
      1,
    );
    expect(asked).toEqual([2]);
    expect(text).toContain('Dentista mañana');
  });

  it('a 7-day agenda reaches its seventh day after today', async () => {
    const text = await readAgendaOverview(
      {
        authorised: () => true,
        now: () => NOW,
        calendar: (days) => calendar(days),
        followups: () => [],
        routines: () => '',
        goals: () => [],
      },
      7,
    );
    expect(text).toContain('Revisión del coche día 7');
  });

  it('the same pairing works for any caller of buildAgenda + loadCalendar', async () => {
    const agenda = await buildAgenda({
      calendar: async () => (await calendar(calendarDaysFor(7))).events,
      now: () => NOW,
      timeZone: TZ,
      days: 7,
    });
    expect(agenda.upcoming.map((i) => i.title)).toEqual([
      'Dentista mañana',
      'Revisión del coche día 7',
    ]);
  });
});
