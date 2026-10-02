import { describe, expect, it, vi } from 'vitest';
import {
  type CalendarEvent,
  createCalendarTool,
  ICS_URL_KEY,
  MAX_AGENDA_DAYS,
  parseIcs,
  summarizeForModel,
} from '../src/tools/calendar.js';

// Stubbed so a test run cannot append to the real daily log, and so "the address
// never reached the log" is an assertion instead of a hope.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { log } = await import('../src/log.js');

/** Real feeds are CRLF; building fixtures that way keeps the parser honest. */
const lines = (...rows: string[]): string => `${rows.join('\r\n')}\r\n`;

/** UTC DTSTART/DTEND stamp, e.g. 20260304T080000Z. */
const stamp = (at: Date): string =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * One UTC event, one TZID event, one all-day event and one floating event, plus a
 * folded SUMMARY and escaped text. Timings are staggered so the sort order is
 * unambiguous: the UTC event and the TZID event would otherwise land on the same
 * instant.
 */
const MIXED = lines(
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//fixture//EN',
  'BEGIN:VEVENT',
  'UID:utc-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260304T060000Z',
  'DTEND:20260304T063000Z',
  'SUMMARY:UTC standup',
  'LOCATION:Room 3\\, building A',
  'DESCRIPTION:Line one\\nLine two\\; with a semi',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:tzid-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART;TZID=Europe/Madrid:20260304T090000',
  'DTEND;TZID=Europe/Madrid:20260304T100000',
  'SUMMARY;LANGUAGE=es:Reunion de equipo',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART;VALUE=DATE:20260305',
  'DTEND;VALUE=DATE:20260307',
  'SUMMARY:Trip to Lisbon',
  'TRANSP:TRANSPARENT',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:floating-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260305T233000',
  'DTEND:20260305T233000',
  'SUMMARY:Floating late call',
  'END:VEVENT',
  'END:VCALENDAR',
);

const NOW = new Date('2026-03-01T00:00:00Z');

describe('parseIcs', () => {
  it('reads UTC, TZID, all-day and floating DTSTART into exact instants', () => {
    const events = parseIcs(MIXED, NOW);
    expect(events.map((e) => e.id)).toEqual(['utc-1', 'tzid-1', 'allday-1', 'floating-1']);

    const utc = events[0] as CalendarEvent;
    expect(utc.start.toISOString()).toBe('2026-03-04T06:00:00.000Z');
    expect(utc.end.toISOString()).toBe('2026-03-04T06:30:00.000Z');

    // 09:00 in Madrid on 4 March 2026 is CEST (UTC+2). Written as a literal ISO
    // instant on purpose: a TZID event must not depend on the host timezone.
    const tzid = events[1] as CalendarEvent;
    expect(tzid.start.toISOString()).toBe('2026-03-04T08:00:00.000Z');
    expect(tzid.end.toISOString()).toBe('2026-03-04T09:00:00.000Z');

    // A VALUE=DATE event has no zone of its own (RFC 5545 §3.3.4), so node-ical
    // anchors it at local midnight. Asserted as local midnight, not as an ISO
    // literal, so the test says what the rule is instead of freezing one machine's
    // offset into the suite.
    const allDay = events[2] as CalendarEvent;
    expect(allDay.allDay).toBe(true);
    expect(allDay.start.getTime()).toBe(new Date(2026, 2, 5, 0, 0, 0, 0).getTime());
    // DTEND is exclusive for all-day events: 5 and 6 March are covered, 7 is not.
    expect(allDay.end.getTime()).toBe(new Date(2026, 2, 7, 0, 0, 0, 0).getTime());

    // Documented decision: a floating value (no Z, no TZID) is read in the host
    // timezone, because RFC 5545 §3.3.5 leaves it to the observer and this agent
    // has no other clock to read it with.
    const floating = events[3] as CalendarEvent;
    expect(floating.start.getTime()).toBe(new Date(2026, 2, 5, 23, 30, 0, 0).getTime());
    expect(floating.end.getTime()).toBe(floating.start.getTime());
  });

  it('unfolds RFC 5545 folded lines and unescapes TEXT values', () => {
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:folded-1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260305T100000Z',
        'SUMMARY:This title was split by the folding r',
        ' ule across two content lines',
        'DESCRIPTION:first part\\nsecond part',
        'LOCATION:Cafe\\, Calle Mayor\\; 4',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      NOW,
    );
    const event = events[0] as CalendarEvent;
    // The leading space on a continuation line is the fold marker and is removed,
    // so the two halves must join with nothing between them.
    expect(event.summary).toBe('This title was split by the folding rule across two content lines');
    expect(event.description).toBe('first part\nsecond part');
    expect(event.location).toBe('Cafe, Calle Mayor; 4');
  });

  it('unwraps a property that carries parameters and reads TRANSP as busy/free', () => {
    const events = parseIcs(MIXED, NOW);
    // SUMMARY;LANGUAGE=es:... comes back as {params, val}; the raw object would be
    // rendered as "[object Object]" in the listing.
    expect((events[1] as CalendarEvent).summary).toBe('Reunion de equipo');
    expect((events[0] as CalendarEvent).busy).toBe(true);
    // TRANSP absent means OPAQUE (RFC 5545 §3.8.2.4); TRANSPARENT is the only free.
    expect((events[2] as CalendarEvent).busy).toBe(false);
  });

  it('expands a recurring series and keeps 09:00 local across a DST change', () => {
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:weekly-1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Europe/Madrid:20260323T090000',
        'DTEND;TZID=Europe/Madrid:20260323T093000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:Weekly review',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      NOW,
    );
    expect(events.map((e) => e.start.toISOString())).toEqual([
      '2026-03-23T08:00:00.000Z', // CET, UTC+1
      '2026-03-30T07:00:00.000Z', // CEST, UTC+2 from 29 March: still 09:00 local
      '2026-04-06T07:00:00.000Z',
    ]);
    // A series shares one UID, so the instance start is what makes the id unique.
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
    expect(events[0]?.id).toBe('weekly-1@2026-03-23T08:00:00.000Z');
  });

  it('drops occurrences listed in EXDATE', () => {
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:class-1',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;TZID=Europe/Madrid:20260302T180000',
        'DTEND;TZID=Europe/Madrid:20260302T183000',
        'RRULE:FREQ=DAILY;COUNT=5',
        'EXDATE;TZID=Europe/Madrid:20260304T180000',
        'SUMMARY:Evening class',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      NOW,
    );
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.start.toISOString().slice(0, 10))).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  it('filters out events that already ended and keeps the ones still running', () => {
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:done',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260225T100000Z',
        'DTEND:20260225T110000Z',
        'SUMMARY:Already over',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:running',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260301T090000Z',
        'DTEND:20260301T170000Z',
        'SUMMARY:Still going',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:later',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260302T090000Z',
        'DTEND:20260302T100000Z',
        'SUMMARY:Tomorrow',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      new Date('2026-03-01T12:00:00Z'),
    );
    expect(events.map((e) => e.summary)).toEqual(['Still going', 'Tomorrow']);
  });

  it('never throws on input that is not a calendar', () => {
    expect(parseIcs('', NOW)).toEqual([]);
    expect(parseIcs('not a calendar at all', NOW)).toEqual([]);
    expect(parseIcs('<html><body>404</body></html>', NOW)).toEqual([]);
    // Truncated mid-component: a VEVENT with no DTSTART is skipped, not fatal.
    expect(parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n', NOW)).toEqual([]);
    expect(
      parseIcs(
        'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:not-a-date\r\nEND:VEVENT\r\n',
        NOW,
      ),
    ).toEqual([]);
  });

  it('recovers the rest of a feed when one event makes node-ical reject the document', () => {
    // A duplicated DTSTART throws out of parseICS for the WHOLE document, so a
    // single bad event would otherwise produce an empty agenda.
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:good',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260304T100000Z',
        'DTEND:20260304T110000Z',
        'SUMMARY:Good one',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:broken',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260304T120000Z',
        'DTSTART:20260304T130000Z',
        'SUMMARY:Broken',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:also-good',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260304T140000Z',
        'DTEND:20260304T150000Z',
        'SUMMARY:Also good',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      NOW,
    );
    expect(events.map((e) => e.summary)).toEqual(['Good one', 'Also good']);
  });

  it('skips a series it cannot enumerate instead of losing the whole agenda', () => {
    // rrule-temporal gives up after 10,000 iterations, so a sub-hourly rule throws
    // out of expandRecurringEvent. It must not take the other events with it.
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:pathological',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260304T100000Z',
        'DTEND:20260304T100100Z',
        'RRULE:FREQ=SECONDLY',
        'SUMMARY:Every second',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:normal',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260304T140000Z',
        'DTEND:20260304T150000Z',
        'SUMMARY:Normal one',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      NOW,
    );
    expect(events.map((e) => e.summary)).toEqual(['Normal one']);
  });

  it('expands up to the 60 day ceiling and no further', () => {
    // NOW is 1 March, so the ceiling lands on 30 April: an event on 29 April is in
    // the window and one on 1 June is not.
    const events = parseIcs(
      lines(
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:inside',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260429T100000Z',
        'DTEND:20260429T110000Z',
        'SUMMARY:Just inside',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:outside',
        'DTSTAMP:20260101T000000Z',
        'DTSTART:20260601T100000Z',
        'DTEND:20260601T110000Z',
        'SUMMARY:Beyond the ceiling',
        'END:VEVENT',
        'END:VCALENDAR',
      ),
      NOW,
    );
    expect(events.map((e) => e.summary)).toEqual(['Just inside']);
  });
});

/** Minimal event builder so the summariser tests need no .ics at all. */
function event(
  id: string,
  start: string,
  minutes: number,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  const from = new Date(start);
  return {
    id,
    summary: id,
    start: from,
    end: new Date(from.getTime() + minutes * 60_000),
    allDay: false,
    busy: true,
    ...extra,
  };
}

describe('summarizeForModel', () => {
  it('says so when there is nothing', () => {
    expect(summarizeForModel([])).toBe('No events in this window.');
  });

  it('groups by day and puts a timezone offset on every timed line', () => {
    const text = summarizeForModel([
      event('standup', '2026-03-04T08:00:00Z', 30, {
        location: 'Room 3',
        description: 'Bring the\nlatest mockups',
      }),
      event('lunch', '2026-03-04T13:00:00Z', 60),
      event('dentist', '2026-03-06T09:00:00Z', 45, { busy: false }),
    ]);

    // Two day headers for three events: 4 March and 6 March.
    expect(text.match(/^\w{3} \d+ \w{3} 2026$/gm)).toEqual(['Wed 4 Mar 2026', 'Fri 6 Mar 2026']);
    expect(text).toContain('Room 3');
    expect(text).toContain('· free');
    // Every timed line carries its own offset, so "09:00" is never ambiguous.
    // Exactly two spaces: description continuation lines are indented deeper.
    for (const line of text.split('\n').filter((l) => /^ {2}\S/.test(l))) {
      expect(line).toMatch(/^ {2}\d{2}:\d{2}-\d{2}:\d{2} [+-]\d{2}:\d{2} {2}\S/);
    }
    // A description becomes an indented continuation line, with its own newline
    // flattened: a raw newline there would break the one-line-per-event listing.
    expect(text).toContain('      Bring the latest mockups');
    expect(text).not.toContain('Bring the\n');
    // A DST change inside the window must not silently shift the second week.
    expect(text).toMatch(/\+0[12]:00 {2}dentist {2}· free/);
  });

  it('marks a timed event that runs past midnight', () => {
    // Built in local terms on purpose: the marker is about the local day boundary,
    // so a UTC instant would depend on the host offset to produce it.
    const text = summarizeForModel([
      {
        id: 'dinner',
        summary: 'Dinner',
        start: new Date(2026, 2, 4, 23, 0),
        end: new Date(2026, 2, 5, 1, 0),
        allDay: false,
        busy: true,
      },
    ]);
    expect(text).toMatch(/23:00-01:00 [+-]\d{2}:\d{2} \(\+1d\) {2}Dinner/);
  });

  it('never drops events silently when it runs out of budget', () => {
    const events = Array.from({ length: 40 }, (_, i) =>
      event(`event-${i}`, new Date(2026, 2, 4 + i, 9, 0).toISOString(), 30),
    );
    const maxChars = 400;
    const text = summarizeForModel(events, { maxChars });

    expect(text.length).toBeLessThanOrEqual(maxChars);
    const notice = /and (\d+) more not shown/.exec(text);
    expect(notice).not.toBeNull();

    // The number in the notice must equal what the listing actually left out.
    const shown = text.split('\n').filter((line) => line.startsWith('  ')).length;
    expect(shown).toBeGreaterThan(0);
    expect(Number(notice?.[1])).toBe(events.length - shown);
  });

  it('lists everything when the budget is generous', () => {
    const events = [event('a', '2026-03-04T08:00:00Z', 30), event('b', '2026-03-05T08:00:00Z', 30)];
    const text = summarizeForModel(events);
    expect(text).not.toContain('more not shown');
    expect(text).toContain('a');
    expect(text).toContain('b');
  });

  it('counts an all-day event by covered days, not by the exclusive DTEND', () => {
    const start = new Date(2026, 2, 5);
    const text = summarizeForModel([
      {
        id: 'trip',
        summary: 'Trip to Lisbon',
        start,
        end: new Date(2026, 2, 7),
        allDay: true,
        busy: false,
      },
    ]);
    expect(text).toContain('all day (2 days)');
    expect(text).toContain('Trip to Lisbon');
  });
});

const SECRET_URL = 'https://calendar.google.com/calendar/ical/SUPERSECRET/basic.ics';

/** Feed with events an hour, a day and three days out, relative to the real clock. */
function futureFeed(): string {
  const at = (hours: number): Date => new Date(Date.now() + hours * 3_600_000);
  return lines(
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//fixture//EN',
    'BEGIN:VEVENT',
    'UID:near',
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${stamp(at(1))}`,
    `DTEND:${stamp(at(2))}`,
    'SUMMARY:Call the dentist',
    'LOCATION:Phone',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:soon',
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${stamp(at(24))}`,
    `DTEND:${stamp(at(25))}`,
    'SUMMARY:Quarterly review',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:later',
    'DTSTAMP:20260101T000000Z',
    `DTSTART:${stamp(at(24 * 3))}`,
    `DTEND:${stamp(at(24 * 3 + 1))}`,
    'SUMMARY:Offsite',
    'END:VEVENT',
    'END:VCALENDAR',
  );
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? '').join('');
}

/** Capture the thrown error without running the tool twice. */
async function failure(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  throw new Error('expected the tool to fail, but it succeeded');
}

describe('createCalendarTool', () => {
  it('returns the agenda without ever printing the address', async () => {
    const tool = createCalendarTool({
      fetchText: async () => futureFeed(),
      getUrl: async () => SECRET_URL,
    });
    const result = await tool.execute('call-1', { action: 'agenda' });
    const text = textOf(result);

    expect(text).toContain('Call the dentist');
    expect(text).toContain('Quarterly review');
    expect(text).toContain('Phone');
    expect(text).not.toContain('SUPERSECRET');
    expect(text).not.toContain(SECRET_URL);
    expect(text).not.toContain('calendar.google.com');
    // Nothing anywhere in the logged fields either: the address is a password.
    for (const call of vi.mocked(log.info).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SUPERSECRET');
    }
  });

  it('tells the user how to configure it when the vault has no address', async () => {
    const tool = createCalendarTool({
      fetchText: async () => {
        throw new Error('must not be called');
      },
      getUrl: async () => undefined,
    });
    const text = textOf(await tool.execute('call-2', { action: 'agenda' }));

    // These two strings are a contract with the cli.ts wiring: the phrase the user
    // asked for, and the vault key it must store the address under.
    expect(text).toContain('add your secret iCal address to the vault');
    expect(text).toContain(ICS_URL_KEY);
    expect(text).toContain('basic.ics');
  });

  it('treats a 401 as a reset secret address rather than a generic fetch failure', async () => {
    const tool = createCalendarTool({
      fetchText: async () => {
        throw new Error(`401 Unauthorized for ${SECRET_URL}`);
      },
      getUrl: async () => SECRET_URL,
    });

    await expect(tool.execute('call-3', { action: 'agenda' })).rejects.toThrow(/401/);
    const error = await failure(tool.execute('call-3', { action: 'agenda' }));
    expect(error.message).toMatch(/secret address/i);
    expect(error.message).toContain(ICS_URL_KEY);
    expect(error.message).not.toContain('SUPERSECRET');
    expect(error.message).not.toContain(SECRET_URL);
  });

  it('redacts the address out of any other fetch failure', async () => {
    const tool = createCalendarTool({
      fetchText: async () => {
        throw new Error(`socket hang up while reading ${SECRET_URL}`);
      },
      getUrl: async () => SECRET_URL,
    });
    const error = await failure(tool.execute('call-4', { action: 'agenda' }));

    expect(error.message).toContain('socket hang up');
    expect(error.message).toContain('[redacted]');
    expect(error.message).not.toContain('SUPERSECRET');
  });

  it('refuses an address that is not a public http(s) URL, without echoing it', async () => {
    const tool = createCalendarTool({
      fetchText: async () => {
        throw new Error('must not be called');
      },
      getUrl: async () => 'http://127.0.0.1:8080/basic.ics',
    });
    const error = await failure(tool.execute('call-5', { action: 'agenda' }));

    expect(error.message).toMatch(/not a public http\(s\) URL/);
    expect(error.message).not.toContain('127.0.0.1');
  });

  it('caps days at 60 and floors it at 1', async () => {
    const tool = createCalendarTool({
      fetchText: async () => futureFeed(),
      getUrl: async () => SECRET_URL,
    });
    expect((await tool.execute('call-6', { action: 'agenda', days: 9999 })).details).toMatchObject({
      days: MAX_AGENDA_DAYS,
    });
    expect((await tool.execute('call-7', { action: 'agenda', days: 0 })).details).toMatchObject({
      days: 1,
    });
    // A one day window must not show the event three days out.
    expect(textOf(await tool.execute('call-8', { action: 'agenda', days: 1 }))).not.toContain(
      'Offsite',
    );
    expect(textOf(await tool.execute('call-9', { action: 'agenda', days: 7 }))).toContain(
      'Offsite',
    );
  });

  it('rejects an unknown action', async () => {
    const tool = createCalendarTool({
      fetchText: async () => futureFeed(),
      getUrl: async () => SECRET_URL,
    });
    await expect(
      tool.execute('call-10', { action: 'create' } as unknown as { action: 'agenda' }),
    ).rejects.toThrow(/acción desconocida/);
  });
});
