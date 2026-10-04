import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { classifyKind, extractCommitments, MIN_CONFIDENCE } from '../src/agenda/extract.js';
import type { AgendaEvent } from '../src/agenda/ics.js';
import { loadCalendar, upcomingEvents } from '../src/agenda/ics.js';
import type { UnifiedAgenda } from '../src/agenda/unified.js';
import { buildAgenda, formatAgenda } from '../src/agenda/unified.js';
import { FollowupTracker } from '../src/alerts/followups.js';
import type { MailMessage } from '../src/mail/types.js';

// Stubbed so a test run cannot append to the real daily log, and so "the feed was not
// logged" is an assertion instead of a hope. The calendar address is a credential, so
// nothing here may reach a log line either.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { log } = await import('../src/log.js');

/** Real feeds are CRLF; building fixtures that way keeps the parser honest. */
const lines = (...rows: string[]): string => `${rows.join('\r\n')}\r\n`;

/**
 * Every instant in these tests is built from LOCAL parts (`new Date(y, m, d, h, min)`)
 * on purpose. The module works in the user's zone, so a fixture expressed in UTC
 * would assert the host's offset rather than the behaviour; the one exception is the
 * ICS tests that need an absolute instant, and those are written as ISO literals.
 */
const local = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

/** Monday 2 October 2026, 10:00 local. Tomorrow is the 3rd, so "mañana 03/10" agrees. */
const NOW = local(2026, 10, 2, 10, 0);

function mail(overrides: Partial<MailMessage> & { text: string }): MailMessage {
  return {
    id: 'msg-1',
    from: 'no-reply@ejemplo.com',
    to: ['yo@ejemplo.com'],
    subject: '',
    at: NOW - 3_600_000,
    seen: false,
    folder: 'INBOX',
    ...overrides,
  };
}

function event(overrides: Partial<AgendaEvent> & { start: number }): AgendaEvent {
  return {
    id: 'ev-1',
    title: 'Reunión',
    end: overrides.start + 3_600_000,
    allDay: false,
    source: 'calendar',
    ...overrides,
  };
}

describe('upcomingEvents (ics)', () => {
  const FEED = lines(
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//fixture//EN',
    'BEGIN:VEVENT',
    'UID:tzid-1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Europe/Madrid:20261003T090000',
    'DTEND;TZID=Europe/Madrid:20261003T100000',
    'SUMMARY:Reunion de equipo',
    'LOCATION:Sala 3',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:utc-1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20261003T170000Z',
    'DTEND:20261003T180000Z',
    'SUMMARY:Call with the office',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday-1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART;VALUE=DATE:20261003',
    'DTEND;VALUE=DATE:20261004',
    'SUMMARY:Congreso de Madrid',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:past-1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20261001T090000Z',
    'DTEND:20261001T100000Z',
    'SUMMARY:Ya paso',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:far-1',
    'DTSTAMP:20260101T000000Z',
    'DTSTART:20261120T090000Z',
    'DTEND:20261120T100000Z',
    'SUMMARY:Dentro de un mes',
    'END:VEVENT',
    'END:VCALENDAR',
  );

  const fetchText = async (): Promise<string> => FEED;

  it('reads TZID, Z and VALUE=DATE into instants that keep their wall clock', async () => {
    const events = await upcomingEvents({
      fetchText,
      getUrl: async () => 'https://example.test/basic.ics',
      now: () => NOW,
      timeZone: 'Europe/Madrid',
      days: 7,
    });

    const titles = events.map((e) => e.title);
    expect(titles).toContain('Reunion de equipo');
    expect(titles).toContain('Call with the office');
    expect(titles).toContain('Congreso de Madrid');

    const meeting = events.find((e) => e.id === 'tzid-1');
    // THE regression this layer exists for: a 09:00 meeting in Madrid must read 09:00,
    // on any host, in any zone. Asserted through the local clock, not an ISO literal,
    // because the claim is about the wall clock and not about one offset.
    expect(meeting).toBeDefined();
    expect(new Date(meeting?.start ?? 0).getHours()).toBe(9);
    expect(zonedStart(meeting?.start ?? 0, 'Europe/Madrid')).toBe('2026-10-03T09:00');
    // Madrid on 3 October 2026 is CEST (UTC+2): 09:00 wall clock is 07:00Z.
    expect(new Date(meeting?.start ?? 0).toISOString()).toBe('2026-10-03T07:00:00.000Z');
    expect(meeting?.location).toBe('Sala 3');
    expect(meeting?.allDay).toBe(false);
    expect(meeting?.source).toBe('calendar');

    // A `Z` value is an absolute instant: 17:00Z stays 17:00Z everywhere.
    const utc = events.find((e) => e.id === 'utc-1');
    expect(new Date(utc?.start ?? 0).toISOString()).toBe('2026-10-03T17:00:00.000Z');
    // 17:00Z is 19:00 in Madrid, so it must still land on the 3rd and after the 09:00.
    expect(zonedStart(utc?.start ?? 0, 'Europe/Madrid')).toBe('2026-10-03T19:00');
  });

  it('never turns an all-day event into 00:00-00:00', async () => {
    const events = await upcomingEvents({
      fetchText,
      getUrl: async () => 'https://example.test/basic.ics',
      now: () => NOW,
      timeZone: 'Europe/Madrid',
      days: 7,
    });
    const allDay = events.find((e) => e.id === 'allday-1');
    expect(allDay?.allDay).toBe(true);
    // DTEND is exclusive, so a one-day VALUE=DATE event arrives as start == end. Left
    // alone it renders as 00:00-00:00, i.e. an event with no duration at all.
    expect(allDay?.end).toBeGreaterThan(allDay?.start ?? 0);
    expect(zonedStart(allDay?.start ?? 0, 'Europe/Madrid')).toBe('2026-10-03T00:00');

    // Explicitly degenerate feeds are widened too, rather than reported as zero-length.
    const degenerate = await upcomingEvents({
      fetchText: async () =>
        lines(
          'BEGIN:VCALENDAR',
          'VERSION:2.0',
          'BEGIN:VEVENT',
          'UID:day-1',
          'DTSTAMP:20260101T000000Z',
          'DTSTART;VALUE=DATE:20261003',
          'SUMMARY:Dia suelto',
          'END:VEVENT',
          'END:VCALENDAR',
        ),
      getUrl: async () => 'https://example.test/basic.ics',
      now: () => NOW,
      timeZone: 'Europe/Madrid',
      days: 7,
    });
    const solo = degenerate[0];
    expect(solo?.allDay).toBe(true);
    expect(solo?.end).toBeGreaterThan(solo?.start ?? 0);
  });

  it('keeps what is in the window and drops what is over or already finished', async () => {
    const sevenDays = await upcomingEvents({
      fetchText,
      getUrl: async () => 'https://example.test/basic.ics',
      now: () => NOW,
      timeZone: 'Europe/Madrid',
      days: 7,
    });
    // Sorted by start, and an all-day event starts at midnight, so it leads the day
    // it belongs to rather than claiming to begin after the morning meeting.
    expect(sevenDays.map((e) => e.id)).toEqual(['allday-1', 'tzid-1', 'utc-1']);
    // Finished the day before: an agenda of what is coming up, not a diary.
    expect(sevenDays.map((e) => e.id)).not.toContain('past-1');
    // The window is 7 days, not 7 weeks.
    expect(sevenDays.map((e) => e.id)).not.toContain('far-1');

    // `days` counts from today, so everything in this feed is tomorrow and a one-day
    // window is legitimately empty. A window that leaked tomorrow's events in would
    // make "what do I have today" answer a different question.
    const today = await upcomingEvents({
      fetchText,
      getUrl: async () => 'https://example.test/basic.ics',
      now: () => NOW,
      timeZone: 'Europe/Madrid',
      days: 1,
    });
    expect(today).toEqual([]);

    const twoDays = await upcomingEvents({
      fetchText,
      getUrl: async () => 'https://example.test/basic.ics',
      now: () => NOW,
      timeZone: 'Europe/Madrid',
      days: 2,
    });
    expect(twoDays.map((e) => e.id)).toContain('tzid-1');
    expect(twoDays.map((e) => e.id)).not.toContain('far-1');
  });

  it('says why there is nothing instead of throwing, and never echoes the address', async () => {
    const missing = await loadCalendar({
      fetchText: async () => {
        throw new Error('must not be called');
      },
      getUrl: async () => undefined,
      now: () => NOW,
    });
    expect(missing.events).toEqual([]);
    expect(missing.configured).toBe(false);
    expect(missing.reason).toMatch(/no hay calendario/i);

    const secret = 'https://calendar.google.com/calendar/ical/SUPERSECRET/basic.ics';
    // The address is a read-only password over the whole calendar, and the fetcher is
    // injected by the caller, so a hand-edited vault entry pointing at localhost is
    // refused before anything is fetched - and refused without printing what was stored.
    const refused = await loadCalendar({
      fetchText: async () => {
        throw new Error('must not be called');
      },
      getUrl: async () => 'http://127.0.0.1:8080/basic.ics',
      now: () => NOW,
    });
    expect(refused.events).toEqual([]);
    expect(refused.reason).toMatch(/http/i);
    expect(refused.reason).not.toContain('127.0.0.1');

    const broken = await loadCalendar({
      fetchText: async () => {
        throw new Error(`401 Unauthorized for ${secret}`);
      },
      getUrl: async () => secret,
      now: () => NOW,
    });
    expect(broken.events).toEqual([]);
    expect(broken.reason).toMatch(/401/);
    expect(broken.reason).not.toContain('SUPERSECRET');
    // Nothing anywhere in the log either.
    for (const call of vi.mocked(log.warn).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SUPERSECRET');
    }

    // A feed that is not a calendar at all is an empty agenda, not a crash.
    const garbage = await loadCalendar({
      fetchText: async () => '<html><body>404</body></html>',
      getUrl: async () => secret,
      now: () => NOW,
    });
    expect(garbage.events).toEqual([]);
    expect(garbage.configured).toBe(true);
  });
});

describe('extractCommitments', () => {
  it('pulls the date and the hour out of a train confirmation', () => {
    const found = extractCommitments(
      [
        mail({
          id: 'renfe-1',
          from: 'no-reply@renfe.com',
          subject: 'Billete confirmado. Madrid - Barcelona',
          text: 'Billete confirmado. Madrid - Barcelona, mañana 03/10 salida 18:27. Coche 7, plaza 22.',
        }),
      ],
      { now: NOW },
    );

    expect(found).toHaveLength(1);
    const trip = found[0];
    expect(trip?.kind).toBe('travel');
    // 3 October 2026 at 18:27 local: the day comes from "03/10" AND from "mañana",
    // which agree, and the hour from "salida 18:27" rather than from the subject.
    expect(trip?.at).toBe(local(2026, 10, 3, 18, 27));
    expect(trip?.timed).toBe(true);
    expect(trip?.subject).toContain('Madrid');
    expect(trip?.subject).toContain('Barcelona');
    expect(trip?.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(trip?.source).toEqual({ messageId: 'renfe-1', from: 'no-reply@renfe.com' });
    expect(trip?.because).toContain('travel');
  });

  it('reads English dates and times the same way', () => {
    const found = extractCommitments(
      [
        mail({
          from: 'bookings@hotel.test',
          subject: 'Your booking is confirmed',
          text: 'Your booking is confirmed for Friday, October 9th at 6pm. Reference: HTL88213.',
        }),
      ],
      { now: NOW },
    );
    // 9 October 2026 is a Friday; the weekday and the spelled-out date agree.
    expect(found[0]?.at).toBe(local(2026, 10, 9, 18, 0));
    expect(found[0]?.kind).toBe('travel');
  });

  it('proposes nothing for a shipping notice with no date at all', () => {
    // The archetypal false positive: a real mail about a real thing, with nothing in
    // it that says when. No date, no commitment - it is not a date we cannot find, it
    // is a thing that is not a commitment.
    expect(
      extractCommitments(
        [
          mail({
            id: 'shop-1',
            from: 'no-reply@tienda.test',
            subject: 'Tu pedido ha sido enviado',
            text: 'Tu pedido ha sido enviado. Gracias por comprar con nosotros.',
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it('proposes nothing for a shipping notice whose date is a range', () => {
    // "Entre el 3 y el 10" is how every courier says "soon". It is a week the user did
    // not choose, and it would own a slot in the agenda forever if it were kept.
    expect(
      extractCommitments(
        [
          mail({
            id: 'shop-2',
            from: 'no-reply@tienda.test',
            subject: 'Tu pedido ha sido enviado',
            text: 'Tu pedido ha sido enviado. Recibirás el paquete entre el 3 y el 10 de octubre.',
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it('does not propose a date that has already passed', () => {
    const found = extractCommitments(
      [
        mail({
          id: 'old-1',
          from: 'no-reply@ejemplo.test',
          subject: 'Acta de la reunión',
          text: 'Acta de la reunión del 01/10/2026 a las 10:00. Enviada por si quieres revisarla.',
        }),
        mail({
          id: 'old-2',
          from: 'no-reply@ejemplo.test',
          subject: 'Reserva antigua',
          text: 'Tu reserva de hotel del 28/09/2026 se canceló. Aquí tienes el reembolso.',
        }),
      ],
      { now: NOW },
    );
    // NOW is the 2nd of October: both of those are history, not plans. "Reunión" and
    // "reserva" would both have cleared the bar on their keywords alone.
    expect(found).toEqual([]);
  });

  it('drops a vague relative date on its own, and keeps it with a time and a keyword', () => {
    const vague = extractCommitments(
      [
        mail({
          id: 'mkt-1',
          from: 'boletin@ejemplo.test',
          subject: 'Novedades',
          // A campaign with a date in it and nothing else: below the bar on purpose,
          // because "en 5 dias" is the marketing calendar's own vocabulary.
          text: `Save the date: our new collection arrives in 5 days. ${'Learn more about the season. '.repeat(20)}`,
        }),
      ],
      { now: NOW },
    );
    expect(vague).toEqual([]);

    const real = extractCommitments(
      [
        mail({
          id: 'cita-1',
          from: 'clinica@ejemplo.test',
          subject: 'Confirmación de cita',
          text: 'Confirmamos tu cita: en 2 días a las 17:30 en la planta 2.',
        }),
      ],
      { now: NOW },
    );
    expect(real).toHaveLength(1);
    expect(real[0]?.at).toBe(local(2026, 10, 4, 17, 30));
    expect(real[0]?.kind).toBe('meeting');
  });

  it('keeps a payment due today and marks it as having no hour', () => {
    const found = extractCommitments(
      [
        mail({
          id: 'factura-1',
          from: 'facturacion@ejemplo.test',
          subject: 'Factura 2026-4471',
          text: 'Factura 2026-4471 por 43,20 €. Vence el 02/10/2026.',
        }),
      ],
      { now: NOW },
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('payment');
    expect(found[0]?.at).toBe(local(2026, 10, 2, 9, 0));
    expect(found[0]?.timed).toBe(false);
    expect(found[0]?.subject).toContain('43,20');
  });

  it('returns everything sorted by date and never below the confidence floor', () => {
    const found = extractCommitments(
      [
        mail({
          id: 'a',
          subject: 'Factura',
          text: 'Factura por 10,00 €. Vence el 05/10/2026.',
        }),
        mail({
          id: 'b',
          subject: 'Reserva',
          text: 'Reserva confirmada para mañana a las 12:00.',
        }),
        mail({ id: 'c', subject: 'Novedades', text: 'Sin fechas aquí.' }),
      ],
      { now: NOW },
    );
    expect(found.map((c) => c.at)).toEqual([local(2026, 10, 3, 12, 0), local(2026, 10, 5, 9, 0)]);
    for (const commitment of found)
      expect(commitment.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it('classifies a bare title without pretending to know more', () => {
    expect(classifyKind('Vuelo a Lisboa')).toBe('travel');
    expect(classifyKind('Factura del seguro')).toBe('payment');
    expect(classifyKind('Weekly sync')).toBe('meeting');
    expect(classifyKind('Cosas')).toBe('other');
  });
});

describe('buildAgenda', () => {
  it('works with only a calendar, and with mail and follow-ups missing', async () => {
    const onlyCalendar = await buildAgenda({
      calendar: async () => [event({ start: local(2026, 10, 2, 12, 0), title: 'Comida' })],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    expect(onlyCalendar.today).toHaveLength(1);
    expect(onlyCalendar.today[0]?.where).toBe('calendario');
    expect(onlyCalendar.upcoming).toEqual([]);
    expect(onlyCalendar.pending).toEqual([]);
    expect(onlyCalendar.notes).toEqual([]);
    expect(onlyCalendar.counts).toEqual({ calendar: 1, mail: 0, pending: 0 });

    const empty = await buildAgenda({
      calendar: async () => [],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    expect(empty.today).toEqual([]);
    expect(formatAgenda(empty, { timeZone: 'Europe/Madrid' })).toMatch(/no tienes nada/i);

    // A source that throws must degrade the agenda, not end it: the user still gets
    // the calendar, plus a line saying the mail was not read.
    const broken = await buildAgenda({
      calendar: async () => [event({ start: local(2026, 10, 2, 12, 0), title: 'Comida' })],
      mail: async () => {
        throw new Error('imap timeout');
      },
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    expect(broken.today).toHaveLength(1);
    expect(broken.notes.join(' ')).toMatch(/correo/i);
    expect(formatAgenda(broken, { timeZone: 'Europe/Madrid' })).toContain('imap timeout');
  });

  it('lists one entry for a train that is in the calendar AND in the inbox', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        event({
          id: 'cal-1',
          title: 'Tren Madrid - Barcelona',
          start: local(2026, 10, 3, 18, 30),
        }),
      ],
      mail: async () => [
        mail({
          id: 'renfe-1',
          from: 'no-reply@renfe.com',
          subject: 'Billete confirmado. Madrid - Barcelona',
          text: 'Billete confirmado. Madrid - Barcelona, mañana 03/10 salida 18:27.',
        }),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });

    expect(agenda.upcoming).toHaveLength(1);
    const merged = agenda.upcoming[0];
    expect(merged?.sources).toEqual(['calendario', 'correo']);
    // Both counted: the merge hides one line, it does not hide a source.
    expect(agenda.counts).toEqual({ calendar: 1, mail: 1, pending: 0 });
    // The calendar keeps the hour, because the user put it there themselves.
    expect(merged?.at).toBe(local(2026, 10, 3, 18, 30));
    expect(formatAgenda(agenda, { timeZone: 'Europe/Madrid' })).toContain('(calendario+correo)');
  });

  it('keeps two different things on the same day apart', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        event({ id: 'a', title: 'Dentista', start: local(2026, 10, 2, 9, 0) }),
        event({ id: 'b', title: 'Seminario de leadership', start: local(2026, 10, 2, 17, 0) }),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    expect(agenda.today).toHaveLength(2);
  });

  it('puts a payment with no hour before a timed meeting today', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        event({ title: 'Reunión de equipo', start: local(2026, 10, 2, 9, 0) }),
      ],
      mail: async () => [
        mail({
          id: 'factura-1',
          subject: 'Factura 2026-4471',
          text: 'Factura 2026-4471 por 43,20 €. Vence el 02/10/2026.',
        }),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });

    // The deadline has no hour and still leads: it is the thing that gets missed.
    expect(agenda.today.map((item) => item.kind)).toEqual(['payment', 'meeting']);
    expect(agenda.today[0]?.timed).toBe(false);
    const text = formatAgenda(agenda, { timeZone: 'Europe/Madrid' });
    expect(text.indexOf('sin hora')).toBeLessThan(text.indexOf('09:00'));
  });

  it('reads the real follow-up tracker without the caller reshaping it', async () => {
    const tracker = new FollowupTracker({ db: new DatabaseSync(':memory:') });
    tracker.track('salud', 'payment', 'Pagar el seguro', NOW + 2 * 86_400_000);
    tracker.track('trabajo', 'otro', 'Responder a Juan', 0);
    const agenda = await buildAgenda({
      calendar: async () => [],
      followups: () => tracker.list(),
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });

    expect(agenda.pending).toHaveLength(2);
    const [dated, undated] = agenda.pending;
    expect(dated?.title).toBe('Pagar el seguro');
    expect(dated?.kind).toBe('payment');
    expect(dated?.where).toBe('pendiente');
    expect(dated?.at).toBe(NOW + 2 * 86_400_000);
    // A note with dueAt 0 is "no date, only contact recency": no invented date.
    expect(undated?.title).toBe('Responder a Juan');
    expect(undated?.kind).toBe('reminder');
    expect(undated?.at).toBeNull();
    // A dated follow-up lands in the agenda's own section, not in a day's schedule.
    expect(formatAgenda(agenda, { timeZone: 'Europe/Madrid' })).toMatch(/Pendientes/);
  });
});

describe('formatAgenda', () => {
  function agendaOf(overrides: Partial<UnifiedAgenda> = {}): UnifiedAgenda {
    return {
      today: [],
      upcoming: [],
      pending: [],
      generatedAt: NOW,
      days: 7,
      counts: { calendar: 0, mail: 0, pending: 0 },
      notes: [],
      ...overrides,
    };
  }

  it('says nothing is planned, in one sentence, when there is nothing', () => {
    const text = formatAgenda(agendaOf(), { timeZone: 'Europe/Madrid' });
    expect(text).toMatch(/no tienes nada/i);
    expect(text.split('\n')).toHaveLength(1);
  });

  it('orders by hour, groups by day, and stays plain text', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        event({ id: 'c', title: 'Comida con el equipo', start: local(2026, 10, 2, 14, 0) }),
        event({ id: 'a', title: 'Desayuno', start: local(2026, 10, 2, 8, 30) }),
        event({ id: 'd', title: 'Congreso', start: local(2026, 10, 5, 9, 0), allDay: true }),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    const text = formatAgenda(agenda, { timeZone: 'Europe/Madrid' });

    expect(text.split('\n')).toEqual([
      'Hoy',
      '- 08:30  Desayuno (calendario)',
      '- 14:00  Comida con el equipo (calendario)',
      'Esta semana',
      'lunes 05/10',
      '- todo el día  Congreso (calendario)',
    ]);
    // Telegram's Markdown parser turns ** and # into noise or an API error.
    expect(text).not.toContain('**');
    expect(text).not.toContain('#');
    expect(text).not.toContain('_');
  });

  it('puts tomorrow under its own heading with the day spelled out', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        event({ id: 'b', title: 'Tren a Barcelona', start: local(2026, 10, 3, 18, 30) }),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    const text = formatAgenda(agenda, { timeZone: 'Europe/Madrid' });
    expect(text.split('\n')).toEqual([
      'Mañana, sábado 03/10',
      '- 18:30  Tren a Barcelona (calendario)',
    ]);
  });

  it('never prints an hour for something that has none', () => {
    const text = formatAgenda(
      agendaOf({
        today: [
          {
            at: local(2026, 10, 2, 9, 0),
            title: 'Pagar la factura',
            kind: 'payment',
            where: 'correo',
            timed: false,
            confidence: 0.7,
            sources: ['correo'],
          },
        ],
      }),
      { timeZone: 'Europe/Madrid' },
    );
    // 09:00 is the nominal anchor, and printing it would be a lie about a mail that
    // only ever said "vence el 02/10".
    expect(text).not.toContain('09:00');
    expect(text).toContain('sin hora');
    // Under 0.8 the item came from heuristics, and the user is told so.
    expect(text).toContain('(correo)');
    expect(text).toContain('70% seguro');
  });
});

/** `YYYY-MM-DDTHH:MM` as read in `timeZone`, so a fixture can be stated in wall time. */
function zonedStart(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}T${read('hour')}:${read('minute')}`;
}
