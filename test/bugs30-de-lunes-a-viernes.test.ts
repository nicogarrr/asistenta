import { describe, expect, it } from 'vitest';
import { scheduleFromWords } from '../src/tools/reminder.js';

// «recuérdame de lunes a viernes a las 7:30 la pastilla»: antes no contaba como repetido,
// se ignoraban sus palabras y valía lo que el modelo pusiera de cron.
describe('«de lunes a viernes» en un recordatorio', () => {
  it.each([
    ['de lunes a viernes a las 7:30', '30 7 * * 1-5'],
    ['de lunes a viernes a las 7', '0 7 * * 1-5'],
    ['de lunes a jueves a las 8', '0 8 * * 1-4'],
    ['recuérdame de lunes a viernes a las 7 y media tomar la pastilla', '30 7 * * 1-5'],
  ])('%s', (t, cron) => {
    expect(scheduleFromWords(t)).toBe(cron);
  });
  it('sin palabra de repetir sigue sin ser rutina', () => {
    expect(scheduleFromWords('mañana a las 9 dentista')).toBeNull();
  });
});
