import { describe, expect, it } from 'vitest';
import { normaliseTime } from '../src/tasks/board.js';

describe('tareas: horas de noche y madrugada', () => {
  it('«12 de la noche» y «12am» son medianoche, no mediodía', () => {
    expect(normaliseTime('12 de la noche')).toBe('00:00');
    expect(normaliseTime('a las doce de la noche')).toBe('00:00');
    expect(normaliseTime('12 de la madrugada')).toBe('00:00');
    expect(normaliseTime('12am')).toBe('00:00');
    expect(normaliseTime('12 y media de la noche')).toBe('00:30');
  });

  it('la una o las tres de la noche son de madrugada', () => {
    expect(normaliseTime('la una de la noche')).toBe('01:00');
    expect(normaliseTime('las 3 de la noche')).toBe('03:00');
    expect(normaliseTime('3 de la madrugada')).toBe('03:00');
  });

  it('lo de siempre sigue igual', () => {
    expect(normaliseTime('9 de la noche')).toBe('21:00');
    expect(normaliseTime('11 de la noche')).toBe('23:00');
    expect(normaliseTime('12 de la tarde')).toBe('12:00');
    expect(normaliseTime('12pm')).toBe('12:00');
    expect(normaliseTime('5 de la tarde')).toBe('17:00');
    expect(normaliseTime('mediodía')).toBe('12:00');
    expect(normaliseTime('12 menos cuarto de la noche')).toBe('23:45');
  });
});
