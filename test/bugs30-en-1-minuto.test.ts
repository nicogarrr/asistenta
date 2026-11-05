import { describe, expect, it } from 'vitest';
import { hourIsAmbiguous, snoozeWhen, whenFromWords } from '../src/tools/reminder.js';

// bugs30: a las 10:15, «recuérdamelo en 1 minuto» (por debajo del mínimo de 2) se leía como
// una hora «de las dos lecturas» y el aviso se iba a las 22:16.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-05T10:15:00+01:00');

describe('«en 1 minuto» no salta 12 horas (bugs30)', () => {
  it('posponer «en 1 minuto» / «dentro de un minuto» no lo deja para la noche', () => {
    for (const said of ['en 1 minuto', 'dentro de un minuto', 'recuérdamelo en 1 minuto']) {
      const at = snoozeWhen(said, NOW, TZ);
      expect(at === null || at.getTime() - NOW.getTime() < 3_600_000).toBe(true);
    }
  });
  it('las palabras «en 1 minuto» son dentro de un minuto, no a las 22:16', () => {
    expect(whenFromWords('en 1 minuto', NOW, TZ)?.toISOString()).toBe(
      new Date('2026-11-05T10:16:00+01:00').toISOString(),
    );
    expect(hourIsAmbiguous('en 1 minuto', new Date('2026-11-05T10:16:00+01:00'), TZ)).toBe(false);
  });
  it('lo de siempre: «a las 5» sigue teniendo dos lecturas y «en 10 minutos» va a su hora', () => {
    expect(hourIsAmbiguous('a las 5', new Date('2026-11-05T05:00:00+01:00'), TZ)).toBe(true);
    expect(snoozeWhen('en 10 minutos', NOW, TZ)?.toISOString()).toBe(
      new Date('2026-11-05T10:25:00+01:00').toISOString(),
    );
  });
});
