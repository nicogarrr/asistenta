import { describe, expect, it } from 'vitest';
import { type AgendaOverviewDeps, readAgendaOverview } from '../src/agenda/overview.js';

const base = (extra: Partial<AgendaOverviewDeps> = {}): AgendaOverviewDeps => ({
  authorised: () => true,
  calendar: async () => ({ events: [] }) as never,
  followups: () => [],
  routines: () => 'Rutinas\n- 08:00 resumen',
  goals: () => [],
  now: () => Date.parse('2026-11-05T09:00:00Z'),
  ...extra,
});

/**
 * «¿Qué tengo hoy?» juntaba calendario, recordatorios, rutinas y tareas, pero el tiempo había
 * que pedirlo aparte. Ahora sale arriba, el mismo del resumen de la mañana.
 */
describe('«¿qué tengo hoy?» con el tiempo', () => {
  it('el tiempo de hoy va en la primera línea', async () => {
    const text = await readAgendaOverview(
      base({ weather: async () => 'Gijón: 14°/9°, lluvia probable de 15:00 a 18:00' }),
      1,
    );
    expect(text.split('\n')[0]).toBe('Tiempo hoy: Gijón: 14°/9°, lluvia probable de 15:00 a 18:00');
    expect(text).toContain('08:00 resumen');
  });

  it('sin tiempo configurado, si falla o si tarda: la agenda igual, sin esperar', async () => {
    const plain = await readAgendaOverview(base(), 1);
    expect(plain).not.toContain('Tiempo hoy');
    const broken = await readAgendaOverview(
      base({
        weather: async () => {
          throw new Error('sin red');
        },
      }),
      1,
    );
    expect(broken).not.toContain('Tiempo hoy');
    expect(broken).toContain('08:00 resumen');
    const t0 = Date.now();
    const slow = await readAgendaOverview(base({ weather: () => new Promise(() => {}) }), 1);
    expect(slow).toContain('08:00 resumen');
    expect(Date.now() - t0).toBeLessThan(6_000);
  }, 10_000);

  it('fuera del chat del dueño no lee nada (tampoco el tiempo)', async () => {
    let asked = false;
    const text = await readAgendaOverview(
      base({
        authorised: () => false,
        weather: async () => {
          asked = true;
          return 'x';
        },
      }),
    );
    expect(text).toContain('solo disponible');
    expect(asked).toBe(false);
  });
});
