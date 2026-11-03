import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/**
 * Minutos que la hora no leía: «a las 7:5», «a las 21 30», «a las 9 h 30» sonaban a la hora
 * en punto (7:00, 21:00, 9:00) sin avisar, y «a las 8:5 pm» se leía como 8:17 (el «5 pm» se
 * convertía en 17). Ahora se pregunta: null deja que el asistente pida la hora.
 */
const at = (t: string) => parseNatural(t)?.schedule ?? null;

describe('rutinas: minutos sin leer', () => {
  it.each([
    'cada día a las 7:5 pastilla',
    'cada día a las 7.5 pastilla',
    'cada día a las 21 30 pastilla',
    'cada día a las 9 h 30 riega',
    'cada día a las 8:5 pm riega',
    'cada día a las 9 y a las 21 30 pastilla',
    'cada día a las 9 pastilla y a las 21 30 otra',
  ])('«%s» pregunta en vez de sonar a la hora en punto', (text) => {
    expect(at(text)).toBeNull();
  });

  it('lo que ya iba bien no cambia', () => {
    expect(at('cada día a las 21:30 pastilla')).toBe('30 21 * * *');
    expect(at('cada día a las 21.30 pastilla')).toBe('30 21 * * *');
    expect(at('cada día a las 9h30 riega')).toBe('30 9 * * *');
    expect(at('cada día a las 8:30 pm riega')).toBe('30 20 * * *');
    expect(at('cada día a las 8 pm riega')).toBe('0 20 * * *');
    expect(at('cada día a las 8, 14 y 20 pastilla')).toBe('0 8,14,20 * * *');
    expect(at('cada día a las 8 de la mañana 2 pastillas')).toBe('0 8 * * *');
    expect(at('cada día a las 9 y a las 21 pastilla')).toBe('0 9,21 * * *');
    expect(at('cada día a las 8 y 20 pastilla')).toBe('20 8 * * *');
    expect(at('cada día a las 9 pastilla y a las 21 otra')).toBe('0 9,21 * * *');
  });
});
