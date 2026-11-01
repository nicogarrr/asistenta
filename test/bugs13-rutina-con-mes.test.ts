import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas con mes («en diciembre», «de enero a marzo») (bugs13)', () => {
  it('el mes dicho junto al horario se respeta: antes sonaba todo el año', () => {
    expect(at('cada lunes a las 9 en diciembre')).toBe('0 9 * 12 1');
    expect(at('cada lunes a las 9 en diciembre revisa los regalos')).toBe('0 9 * 12 1');
    expect(at('en diciembre, cada lunes a las 9 revisa los regalos')).toBe('0 9 * 12 1');
    expect(at('cada día a las 8 de enero a marzo riega el limonero')).toBe('0 8 * 1-3 *');
    expect(at('cada día a las 8 de diciembre a febrero')).toBe('0 8 * 12,1,2 *');
    expect(at('cada sábado a las 10 en julio y agosto piscina')).toBe('0 10 * 7,8 6');
    expect(at('los lunes de diciembre a las 9 lotería')).toBe('0 9 * 12 1');
    expect(at('cada 30 min de 9 a 14 en agosto')).toBe('*/30 9-13 * 8 *');
  });

  it('la tarea sigue siendo la frase entera', () => {
    expect(parseNatural('cada lunes a las 9 en diciembre revisa los regalos')?.prompt).toBe(
      'cada lunes a las 9 en diciembre revisa los regalos',
    );
  });

  it('si el mes puede ser parte de la tarea, o es una estación, se pregunta', () => {
    expect(at('cada lunes a las 9 recuérdame comprar turrón en diciembre')).toBeNull();
    expect(at('cada día a las 9 en verano')).toBeNull();
    expect(at('cada 25 de diciembre a las 10 en enero')).toBeNull();
  });

  it('sin mes, todo sigue igual', () => {
    expect(at('cada 25 de diciembre a las 10')).toBe('0 10 25 12 *');
    expect(at('cada lunes a las 9')).toBe('0 9 * * 1');
    expect(at('cada día a las 9 paga el seguro de diciembre')).toBe('0 9 * * *');
  });

  it('/cron lo dice con el mes', () => {
    expect(scheduleEs('0 9 * 12 1')).toBe('cada lunes a las 09:00, en diciembre');
    expect(scheduleEs('0 8 * 1-3 *')).toBe('cada día a las 08:00, de enero a marzo');
    expect(scheduleEs('0 8 * 12,1,2 *')).toBe('cada día a las 08:00, de diciembre a febrero');
    expect(scheduleEs('0 10 * 7,8 6')).toBe('cada sábado a las 10:00, en julio y agosto');
    expect(scheduleEs('0 10 25 12 *')).toBe('cada año el 25/12 a las 10:00');
  });
});
