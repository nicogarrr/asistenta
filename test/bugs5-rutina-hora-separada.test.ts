import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const sched = (s: string): string | null => parseNatural(s)?.schedule ?? null;

describe('rutinas: una segunda hora más adelante en la frase', () => {
  it('«a las 9 pastilla y a las 21 otra» son dos tomas', () => {
    // Antes: «0 9 * * *» y la toma de la noche se perdía sin avisar.
    expect(sched('cada día a las 9 pastilla y a las 21 otra')).toBe('0 9,21 * * *');
    expect(sched('cada día a las 9 pastilla y otra a las 21')).toBe('0 9,21 * * *');
    expect(sched('cada lunes a las 9 fichar y a las 18 también')).toBe('0 9,18 * * 1');
  });

  it('la parte del día de la segunda hora no mueve la primera', () => {
    // Antes: «0 19 * * *», el riego de la mañana pasaba a las 7 de la tarde.
    expect(sched('cada día a las 7 riega las plantas y a las 8 de la tarde también')).toBe(
      '0 7,20 * * *',
    );
    // Antes: «0 21 * * *», la toma de las 9 de la mañana desaparecía.
    expect(sched('cada día a las 9 pastilla y a las 9 de la noche otra')).toBe('0 9,21 * * *');
  });

  it('con minutos distintos se pregunta, como en la lista seguida', () => {
    expect(sched('cada día a las 8:30 pastilla y a las 20:00 otra')).toBeNull();
  });

  it('una hora que forma parte del recado sigue sin ser otra toma', () => {
    expect(sched('cada lunes a las 9 recuérdame que la reunión es a las 11')).toBe('0 9 * * 1');
    expect(sched('cada día a las 9 avísame si hay correo y si no a las 10')).toBe('0 9 * * *');
    expect(sched('cada día a las 6 riega por la tarde')).toBe('0 18 * * *');
  });
});
