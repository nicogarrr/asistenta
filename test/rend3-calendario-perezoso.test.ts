import { describe, expect, it, vi } from 'vitest';

/**
 * node-ical (con rrule-temporal y temporal-polyfill, ~25 módulos y ~25 ms) se
 * carga la primera vez que se lee un calendario, no al importar: cada `pa …` y
 * cada arranque del demonio lo pagaban aunque no hubiera calendario.
 */
const state = vi.hoisted(() => ({ loaded: 0 }));
vi.mock('node-ical', async (orig) => {
  state.loaded++;
  return orig();
});

describe('calendario: node-ical se carga al primer uso', () => {
  it('importar la herramienta y la agenda no carga node-ical; leer un .ics sí, una vez', async () => {
    const { parseIcs } = await import('../src/tools/calendar.js');
    await import('../src/agenda/ics.js');
    expect(state.loaded).toBe(0);

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:a@test',
      'DTSTART:20261103T080000Z',
      'DTEND:20261103T090000Z',
      'SUMMARY:Dentista',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const now = new Date('2026-11-02T07:00:00Z');
    const events = await parseIcs(ics, now);
    expect(events.map((e) => [e.summary, e.start.toISOString(), e.end.toISOString()])).toEqual([
      ['Dentista', '2026-11-03T08:00:00.000Z', '2026-11-03T09:00:00.000Z'],
    ]);
    await parseIcs(ics, now);
    expect(state.loaded).toBe(1);
  });
});
