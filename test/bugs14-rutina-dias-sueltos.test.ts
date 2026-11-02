import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: días de la semana sin «los» y días del mes sin «de cada mes» (bugs14)', () => {
  it('una frase que empieza por los días suena esos días (antes, todos los días)', () => {
    expect(at('lunes, miércoles y viernes a las 7 x')).toBe('0 7 * * 1,3,5');
    expect(at('martes y jueves a las 9 x')).toBe('0 9 * * 2,4');
    expect(at('sábados a las 10 x')).toBe('0 10 * * 6');
    expect(at('lunes a las 7 x')).toBe('0 7 * * 1');
    expect(at('viernes por la tarde x')).toBe('0 18 * * 5');
  });

  it('«los días 1 y 15» son días del mes (antes, todos los días)', () => {
    expect(at('los días 1 y 15 a las 9 x')).toBe('0 9 1,15 * *');
    expect(at('los días 1, 10 y 20 a las 9 x')).toBe('0 9 1,10,20 * *');
    expect(at('todos los días 1 y 15 a las 9 x')).toBe('0 9 1,15 * *');
    expect(at('los días 5 a las 9 x')).toBe('0 9 5 * *');
    expect(at('todos los días 15 a las 9 x')).toBe('0 9 15 * *');
  });

  it('«el día 5 a las 9» o «el 15 a las 9» sin «cada mes» se preguntan (antes, todos los días)', () => {
    expect(at('el día 5 a las 9 x')).toBeNull();
    expect(at('el 15 a las 9 x')).toBeNull();
    expect(at('cada 15 a las 9 x')).toBeNull();
  });

  it('sin cambios', () => {
    expect(at('todos los días a las 9 x')).toBe('0 9 * * *');
    expect(at('los días 1 y 15 de cada mes a las 9 x')).toBe('0 9 1,15 * *');
    expect(at('cada día 1 a las 9 x')).toBe('0 9 1 * *');
    expect(at('el 1 y el 15 de cada mes a las 9 x')).toBe('0 9 1,15 * *');
    expect(at('cada 15 minutos x')).toBe('*/15 * * * *');
    expect(at('los lunes a las 9 x')).toBe('0 9 * * 1');
    expect(at('cada 1 de marzo a las 9 paga el seguro')).toBe('0 9 1 3 *');
  });
});
