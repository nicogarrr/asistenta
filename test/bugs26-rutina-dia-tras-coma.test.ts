import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/**
 * «cada lunes a las 9, miércoles a las 10 gimnasio» quedaba en «0 9 * * 1»: el miércoles a
 * las 10 se perdía sin avisar (con «y el miércoles a las 10» ya se preguntaba). Un cron no
 * dice dos horarios distintos, así que tras una coma también se pregunta.
 */
describe('rutinas: otro día con su propia hora tras una coma', () => {
  it.each([
    'cada lunes a las 9, miércoles a las 10 gimnasio',
    'cada lunes a las 9, y el jueves a las 18 inglés',
    'los lunes a las 9, los jueves a las 18 inglés',
  ])('%s → null (se pregunta)', (text) => {
    expect(parseNatural(text)).toBeNull();
  });

  it('las listas de días u horas siguen igual', () => {
    expect(parseNatural('cada lunes, miércoles y viernes a las 7 gimnasio')?.schedule).toBe(
      '0 7 * * 1,3,5',
    );
    expect(parseNatural('cada día a las 8, 14 y 20 pastilla')?.schedule).toBe('0 8,14,20 * * *');
    expect(parseNatural('cada lunes a las 9, gimnasio')?.schedule).toBe('0 9 * * 1');
    expect(parseNatural('cada día a las 9, recoger el paquete del lunes')?.schedule).toBe(
      '0 9 * * *',
    );
  });
});
