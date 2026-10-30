import { describe, expect, it } from 'vitest';
import type { AgendaEvent } from '../src/agenda/ics.js';
import { buildAgenda } from '../src/agenda/unified.js';

const local = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();
const NOW = local(2026, 10, 2, 8, 0);
const ev = (id: string, title: string, start: number): AgendaEvent => ({
  id,
  title,
  start,
  end: start + 3_600_000,
  allDay: false,
  source: 'calendar',
});

// Dos citas del calendario el mismo día con el mismo título se fundían en una:
// la agenda (y el resumen de la mañana) perdía la segunda sin decir nada.
describe('agenda: deduplicado de citas del calendario', () => {
  it('dos citas con el mismo título a distinta hora se quedan las dos', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        ev('a', 'Dentista', local(2026, 10, 2, 9)),
        ev('b', 'Dentista', local(2026, 10, 2, 17)),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    expect(agenda.today.map((i) => i.at)).toEqual([local(2026, 10, 2, 9), local(2026, 10, 2, 17)]);
  });

  it('la misma cita en dos calendarios (misma hora) sigue saliendo una vez', async () => {
    const agenda = await buildAgenda({
      calendar: async () => [
        ev('a', 'Reunión equipo', local(2026, 10, 2, 10)),
        ev('b', 'Reunión de equipo', local(2026, 10, 2, 10)),
      ],
      now: () => NOW,
      timeZone: 'Europe/Madrid',
    });
    expect(agenda.today).toHaveLength(1);
  });
});
