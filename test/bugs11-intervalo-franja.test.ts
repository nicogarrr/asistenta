import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('intervalos con franja horaria o días (bugs11)', () => {
  it('«cada hora de 9 a 18» no suena de madrugada', () => {
    expect(at('cada hora de 9 a 18 mira el correo')).toBe('0 9-18 * * *');
    expect(at('cada 2 horas de 8 a 20 bebe agua')).toBe('0 8-20/2 * * *');
    expect(at('cada 30 minutos entre las 9 y las 14 revisa')).toBe('*/30 9-13 * * *');
    expect(at('cada media hora desde las 10 hasta las 13 mira')).toBe('*/30 10-12 * * *');
    expect(at('cada hora de 4 a 8 de la tarde riega')).toBe('0 16-20 * * *');
  });

  it('los días dichos cuentan también en un intervalo', () => {
    expect(at('cada media hora de lunes a viernes mira la web')).toBe('*/30 * * * 1-5');
    expect(at('cada 15 minutos los lunes comprueba')).toBe('*/15 * * * 1');
    expect(at('cada hora los fines de semana')).toBe('0 * * * 0,6');
    expect(at('cada hora de 9 a 18 de lunes a viernes correo')).toBe('0 9-18 * * 1-5');
  });

  it('una franja que un cron no dice se pregunta', () => {
    expect(at('cada hora de 22 a 6 vigila')).toBeNull();
    expect(at('cada 30 minutos de 9:30 a 14 mira')).toBeNull();
  });

  it('sin franja ni días, igual que antes', () => {
    expect(at('cada hora bebe agua')).toBe('0 * * * *');
    expect(at('cada 2 horas mira el correo')).toBe('0 */2 * * *');
    expect(at('cada 15 minutos comprueba la web')).toBe('*/15 * * * *');
    expect(at('cada media hora')).toBe('*/30 * * * *');
  });

  it('la lista de rutinas lo dice en palabras', () => {
    expect(scheduleEs('0 9-18 * * 1-5')).toBe('cada hora de 09:00 a 18:00, de lunes a viernes');
    expect(scheduleEs('0 8-20/2 * * *')).toBe('cada 2 horas de 08:00 a 20:00');
    expect(scheduleEs('*/30 9-13 * * *')).toBe('cada 30 min de 09:00 a 14:00');
    expect(scheduleEs('*/30 * * * 1-5')).toBe('cada 30 min, de lunes a viernes');
    expect(scheduleEs('*/15 * * * *')).toBe('cada 15 min');
    expect(scheduleEs('0 */2 * * *')).toBe('cada 2 horas');
  });
});
