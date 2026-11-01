import { describe, expect, it } from 'vitest';
import { formatNextRun } from '../src/daemon/cron-command.js';

// La próxima vez de una rutina, a partir de dos días, redondeaba horas a días: el martes a las
// 21:00 mirado el domingo a las 9:00 (60 h) salía «en 3 d», y es pasado mañana. Ahora los
// días son del calendario.

const at = (iso: string) => Date.parse(iso);

describe('rutinas: «en N d» cuenta días del calendario', () => {
  it('domingo 9:00 → martes 21:00 es «en 2 d»', () => {
    expect(formatNextRun(at('2026-11-03T20:00:00Z'), at('2026-11-01T08:00:00Z'))).toContain(
      '(en 2 d)',
    );
  });

  it('domingo 20:00 → miércoles 8:00 sigue siendo «en 3 d»', () => {
    expect(formatNextRun(at('2026-11-04T07:00:00Z'), at('2026-11-01T19:00:00Z'))).toContain(
      '(en 3 d)',
    );
  });
});
