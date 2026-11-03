import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/**
 * La parte del día dicha ANTES de los minutos («a las 9 de la noche menos cuarto», «a las 6
 * de la mañana y cuarto») cortaba la hora en «de la noche»: los minutos se perdían en
 * silencio y la rutina sonaba a las 21:00 o a las 6:00 en vez de a las 20:45 o a las 6:15.
 */
const at = (t: string) => parseNatural(t)?.schedule;

describe('rutinas: parte del día antes de los minutos', () => {
  it.each([
    ['cada día a las 9 de la noche menos cuarto recoger', '45 20 * * *'],
    ['cada día a las 6 de la mañana y cuarto correr', '15 6 * * *'],
    ['cada día a las 7 de la tarde y media llamar a mamá', '30 19 * * *'],
    ['cada lunes a las nueve de la noche menos diez basura', '50 20 * * 1'],
    ['todos los días a las 8 de la mañana y media pastilla', '30 8 * * *'],
  ])('«%s» → %s', (text, cron) => {
    expect(at(text)).toBe(cron);
  });

  it('«a las 8 de la mañana y 10 de la noche» son dos tomas, no una', () => {
    expect(at('cada día a las 8 de la mañana y 10 de la noche pastilla')).toBe('0 8,22 * * *');
  });

  it('lo que ya iba bien no cambia', () => {
    expect(at('cada día a las 9 menos cuarto de la noche recoger')).toBe('45 20 * * *');
    expect(at('cada día a las 8 y media de la mañana pastilla')).toBe('30 8 * * *');
    expect(at('cada día a las 10 de la noche leer')).toBe('0 22 * * *');
    expect(at('cada día a las 8 de la mañana y a las 8 de la noche pastilla')).toBe('0 8,20 * * *');
  });
});
