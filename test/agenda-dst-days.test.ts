import { describe, expect, it, vi } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';
import type { AgendaEvent } from '../src/agenda/ics.js';
import { upcomingEvents, zonedAddDays, zonedDayKey } from '../src/agenda/ics.js';
import type { AgendaItem, UnifiedAgenda } from '../src/agenda/unified.js';
import { buildAgenda, formatAgenda } from '../src/agenda/unified.js';
import type { MailMessage } from '../src/mail/types.js';
import { collectFindings } from '../src/vigilante.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/**
 * Calendar-day arithmetic across the two DST Sundays in Europe/Madrid.
 *
 * 2026-10-25 has 25 hours (clocks go back 03:00 -> 02:00), 2026-03-29 has 23. Every
 * instant here is an absolute ISO literal so the assertions do not depend on the host.
 */
const TZ = 'Europe/Madrid';
const at = (iso: string): number => Date.parse(iso);
/** Domingo 25 de octubre de 2026, 10:00 en Madrid (ya en CET, UTC+1). */
const DST_SUNDAY = at('2026-10-25T09:00:00Z');
/** Martes 20 de octubre de 2026, 10:00 en Madrid (CEST, UTC+2): el cambio cae dentro de la semana. */
const WEEK_BEFORE = at('2026-10-20T08:00:00Z');

function event(id: string, startIso: string, title = id): AgendaEvent {
  const start = at(startIso);
  return { id, title, start, end: start + 3_600_000, allDay: false, source: 'calendar' };
}

function mail(text: string, now: number): MailMessage {
  return {
    id: 'm1',
    from: 'clinica@ejemplo.test',
    to: ['yo@ejemplo.com'],
    subject: 'Confirmación de cita',
    text,
    at: now - 3_600_000,
    seen: false,
    folder: 'INBOX',
  };
}

describe('zonedAddDays', () => {
  it('walks by calendar date on the 25-hour day (clocks go back)', () => {
    expect(new Date(zonedAddDays(DST_SUNDAY, 1, TZ)).toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
    expect(zonedDayKey(zonedAddDays(DST_SUNDAY, 1, TZ), TZ)).toBe('2026-10-26');
    expect(zonedAddDays(DST_SUNDAY, 0, TZ)).toBe(at('2026-10-24T22:00:00Z'));
  });

  it('walks by calendar date on the 23-hour day (clocks go forward)', () => {
    const springSunday = at('2026-03-29T10:00:00Z');
    expect(new Date(zonedAddDays(springSunday, 1, TZ)).toISOString()).toBe(
      '2026-03-29T22:00:00.000Z',
    );
    expect(zonedDayKey(zonedAddDays(at('2026-03-28T10:00:00Z'), 1, TZ), TZ)).toBe('2026-03-29');
  });

  it('keeps a whole week across the change, rolls months and goes backwards', () => {
    expect(zonedDayKey(zonedAddDays(WEEK_BEFORE, 7, TZ), TZ)).toBe('2026-10-27');
    expect(zonedDayKey(zonedAddDays(at('2026-10-31T12:00:00Z'), 1, TZ), TZ)).toBe('2026-11-01');
    expect(zonedDayKey(zonedAddDays(at('2026-12-31T12:00:00Z'), 1, TZ), TZ)).toBe('2027-01-01');
    expect(zonedAddDays(at('2026-10-26T12:00:00Z'), -1, TZ)).toBe(at('2026-10-24T22:00:00Z'));
  });
});

describe('agenda on the Sunday the clocks go back', () => {
  it('keeps today in «Hoy» instead of an empty today and everything under «Mañana»', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        event('hoy', '2026-10-25T17:00:00Z', 'Cena familiar'),
        event('manana', '2026-10-26T08:00:00Z', 'Dentista'),
      ],
      now: () => DST_SUNDAY,
      timeZone: TZ,
    });
    expect(agenda.today.map((item) => item.title)).toEqual(['Cena familiar']);
    expect(agenda.upcoming.map((item) => item.title)).toEqual(['Dentista']);
  });

  it('a 7-day window that crosses the change still reaches its seventh day', async () => {
    const agenda = await buildAgenda({
      // Tuesday the 20th: seven days after today ends at Wednesday the 28th, 00:00.
      calendar: async () => [event('dia7', '2026-10-27T11:00:00Z', 'Revisión del coche')],
      now: () => WEEK_BEFORE,
      timeZone: TZ,
      days: 7,
    });
    expect(agenda.upcoming.map((item) => item.title)).toEqual(['Revisión del coche']);
  });

  it('formatAgenda heads Monday as «Mañana» on that Sunday', () => {
    const item = (title: string, iso: string): AgendaItem => ({
      at: at(iso),
      title,
      kind: 'meeting',
      where: 'calendario',
    });
    const agenda: UnifiedAgenda = {
      today: [item('Cena familiar', '2026-10-25T17:00:00Z')],
      upcoming: [item('Dentista', '2026-10-26T08:00:00Z')],
      pending: [],
      generatedAt: DST_SUNDAY,
      days: 7,
      counts: { calendar: 2, mail: 0, pending: 0 },
      notes: [],
    };
    const text = formatAgenda(agenda, { timeZone: TZ });
    const lines = text.split('\n');
    const manana = lines.findIndex((line) => line.startsWith('Mañana'));
    expect(manana).toBeGreaterThan(-1);
    expect(lines[manana]).toMatch(/26/);
    expect(lines[manana + 1]).toContain('Dentista');
    expect(text).not.toContain('Esta semana');
  });

  it('calendar feed: the last day of the window is not dropped', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//fixture//EN',
      'BEGIN:VEVENT',
      'UID:d7',
      'DTSTAMP:20261001T000000Z',
      'DTSTART:20261026T110000Z',
      'DTEND:20261026T120000Z',
      'SUMMARY:Lunes 26',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    // From Tuesday the 20th a 7-day window runs to Tuesday the 27th, 00:00: Monday the
    // 26th is inside it, even though the week holds a 25-hour Sunday.
    const events = await upcomingEvents({
      fetchText: async () => ics,
      getUrl: async () => 'https://example.test/cal.ics',
      now: () => WEEK_BEFORE,
      timeZone: TZ,
      days: 7,
    });
    expect(events.map((e) => e.id)).toEqual(['d7']);
  });

  it('reads «mañana» in a mail as Monday, not as the same Sunday', () => {
    const [found] = extractCommitments(
      [mail('Confirmamos tu cita: mañana a las 17:30 en la planta 2.', DST_SUNDAY)],
      {
        now: DST_SUNDAY,
        timeZone: TZ,
      },
    );
    expect(found?.at).toBe(at('2026-10-26T16:30:00Z'));
  });

  it('the proactive watcher keeps a pending item on the seventh day of the window', () => {
    const pending: AgendaItem = {
      at: at('2026-10-27T11:00:00Z'),
      title: 'Pagar el seguro',
      kind: 'payment',
      where: 'pendiente',
    };
    const agenda: UnifiedAgenda = {
      today: [],
      upcoming: [],
      pending: [pending],
      generatedAt: WEEK_BEFORE,
      days: 7,
      counts: { calendar: 0, mail: 0, pending: 1 },
      notes: [],
    };
    expect(collectFindings(agenda, TZ, WEEK_BEFORE).map((item) => item.title)).toEqual([
      'Pagar el seguro',
    ]);
  });
});

describe('weekday names are read in the user zone, not the host zone', () => {
  it('«el lunes» on a Friday night in New York is three days away even when the host is in Madrid', () => {
    // Saturday 31 Oct 03:00 in Madrid (the host) is Friday 30 Oct 22:00 in New York.
    const now = at('2026-10-31T02:00:00Z');
    const [found] = extractCommitments(
      [mail('Confirmamos tu cita el lunes a las 17:30 en la planta 2.', now)],
      {
        now,
        timeZone: 'America/New_York',
      },
    );
    // Monday 2 Nov 17:30 in New York (EST after 1 Nov) = 22:30Z.
    expect(found?.at).toBe(at('2026-11-02T22:30:00Z'));
  });
});
