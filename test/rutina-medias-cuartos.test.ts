import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// gertru-gaps-6: «cada día a las 8 y media» quedaba a las 8:00.
describe('rutinas: medias y cuartos', () => {
  const at = (text: string) => parseNatural(text)?.schedule;

  it('«y media», «y cuarto», «menos cuarto»', () => {
    expect(at('cada día a las 8 y media revisa el correo')).toBe('30 8 * * *');
    expect(at('todos los lunes a las 9 y cuarto reunión')).toBe('15 9 * * 1');
    expect(at('cada día a las 9 menos cuarto saca al perro')).toBe('45 8 * * *');
    expect(at('cada día a la una menos cuarto comer')).toBe('45 0 * * *');
    expect(at('cada día a las 7 y media de la tarde riega')).toBe('30 19 * * *');
  });

  it('«8.30» y «20h30» como se escriben', () => {
    expect(at('cada día a las 8.30 resumen')).toBe('30 8 * * *');
    expect(at('cada día a las 20h30 resumen')).toBe('30 20 * * *');
    expect(at('cada día a las 20:30 resumen')).toBe('30 20 * * *');
    expect(at('cada día a las 8 horas resumen')).toBe('0 8 * * *');
  });
});
