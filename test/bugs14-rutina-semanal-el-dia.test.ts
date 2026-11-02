import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas semanales con «el martes» (bugs14)', () => {
  it('«cada semana el martes» suena el martes (antes el lunes)', () => {
    expect(at('cada semana el martes a las 10 x')).toBe('0 10 * * 2');
    expect(at('semanalmente el jueves a las 10 x')).toBe('0 10 * * 4');
    expect(at('cada semana, el domingo a las 20 x')).toBe('0 20 * * 0');
    expect(at('cada semana el sábado por la mañana x')).toBe('0 8 * * 6');
  });

  it('«todas las semanas» y «una vez a la semana» son semanales (antes, todos los días)', () => {
    expect(at('todas las semanas el viernes a las 9 x')).toBe('0 9 * * 5');
    expect(at('una vez a la semana el viernes a las 9 x')).toBe('0 9 * * 5');
    expect(at('todas las semanas a las 9 x')).toBe('0 9 * * 1');
  });

  it('«el martes a las 10» sin «cada» es un día suelto: se pregunta (antes, todos los días)', () => {
    expect(at('el martes a las 10 x')).toBeNull();
    expect(at('el próximo viernes a las 9 x')).toBeNull();
  });

  it('sin cambios: «los martes», «cada semana a las 10», un día dentro de la tarea', () => {
    expect(at('cada semana los jueves a las 10 x')).toBe('0 10 * * 4');
    expect(at('los martes a las 10 x')).toBe('0 10 * * 2');
    expect(at('cada semana a las 10 x')).toBe('0 10 * * 1');
    expect(at('cada día a las 9 dime qué hay el martes')).toBe('0 9 * * *');
    expect(at('dos veces a la semana a las 9 x')).toBeNull();
  });
});
