import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: «cada hora por la mañana» y «en horario laboral» (bugs12)', () => {
  it('«por la mañana / tarde / noche» limita el intervalo a esa parte del día', () => {
    expect(at('cada hora por la mañana bebe agua')).toBe('0 8-13 * * *');
    expect(at('cada hora por las mañanas bebe agua')).toBe('0 8-13 * * *');
    expect(at('cada media hora por la tarde estira')).toBe('*/30 15-19 * * *');
    expect(at('cada 2 horas por la noche mira el horno')).toBe('0 20-23/2 * * *');
    expect(at('cada hora durante la mañana los lunes x')).toBe('0 8-13 * * 1');
  });

  it('«en horario laboral» es de 9 a 18 de lunes a viernes', () => {
    expect(at('cada hora en horario laboral estira')).toBe('0 9-18 * * 1-5');
    expect(at('cada 30 minutos en horario de oficina bebe agua')).toBe('*/30 9-17 * * 1-5');
    expect(at('cada hora en horario laboral los lunes x')).toBe('0 9-18 * * 1');
    expect(scheduleEs('0 9-18 * * 1-5')).not.toBeNull();
  });

  it('«a partir de las 9» / «desde las 9» empieza a esa hora', () => {
    expect(at('cada hora a partir de las 9 bebe agua')).toBe('0 9-23 * * *');
    expect(at('cada media hora desde las 4 de la tarde x')).toBe('*/30 16-23 * * *');
    expect(at('cada 2 horas a partir de las 8 x')).toBe('0 8-23/2 * * *');
    expect(at('cada hora desde las 8 hasta las 20 x')).toBe('0 8-20 * * *');
  });

  it('«cada hora y media» se pregunta, no suena cada hora', () => {
    expect(at('cada hora y media bebe agua')).toBeNull();
    expect(at('cada 2 horas y media mira el horno')).toBeNull();
    expect(at('cada dos horas y cuarto x')).toBeNull();
    expect(at('cada hora y 20 minutos x')).toBeNull();
    expect(at('cada media hora x')).toBe('*/30 * * * *');
    expect(at('cada 2 horas x')).toBe('0 */2 * * *');
  });

  it('una franja dicha con horas manda sobre la parte del día', () => {
    expect(at('cada hora de 9 a 12 por la mañana x')).toBe('0 9-12 * * *');
    expect(at('cada hora de 22 a 6 por la noche x')).toBeNull();
    expect(at('cada hora x')).toBe('0 * * * *');
    expect(at('todos los días por la mañana x')).toBe('0 8 * * *');
  });
});
