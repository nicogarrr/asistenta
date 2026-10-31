import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

// gertru-gaps-8: «a las 8 y 15» y «a las 9 y treinta y cinco» sonaban en punto, y «de
// viernes a lunes» o «de domingo a jueves» no se leían (la rutina sonaba cada día).
describe('rutinas: minutos en cifras y rangos de días que dan la vuelta', () => {
  const at = (text: string) => parseNatural(text)?.schedule;

  it('minutos en cifra detrás de «y» / «menos»', () => {
    expect(at('cada día a las 8 y 15 toma la pastilla')).toBe('15 8 * * *');
    expect(at('todos los días a las 7 y 5 despiértame')).toBe('5 7 * * *');
    expect(at('cada día a las 9 menos 10 sal de casa')).toBe('50 8 * * *');
  });

  it('minutos en palabras que antes no se leían', () => {
    expect(at('cada día a las ocho y quince toma la pastilla')).toBe('15 8 * * *');
    expect(at('cada día a las nueve y treinta y cinco llama a casa')).toBe('35 9 * * *');
    expect(at('los lunes a las 6 y cincuenta y cinco de la tarde gimnasio')).toBe('55 18 * * 1');
    expect(at('cada día a las 10 y veintidós riega')).toBe('22 10 * * *');
    // Lo de antes sigue igual.
    expect(at('cada día a las 8 y media lee')).toBe('30 8 * * *');
    expect(at('cada día a las nueve menos cuarto sal')).toBe('45 8 * * *');
  });

  it('un minuto imposible no se inventa', () => {
    expect(parseNatural('cada día a las 8 y 60 haz algo')).toBeNull();
  });

  it('«de viernes a lunes», «de domingo a jueves»', () => {
    expect(at('de viernes a lunes a las 10 saca al perro')).toBe('0 10 * * 5,6,0,1');
    expect(at('de sábado a lunes a las 9 riega')).toBe('0 9 * * 6,0,1');
    expect(at('de domingo a jueves a las 23 acuéstate')).toBe('0 23 * * 0-4');
    expect(at('de martes a sábado a las 10 abre la tienda')).toBe('0 10 * * 2-6');
  });

  it('/recordatorios lo dice en castellano', () => {
    expect(scheduleEs('0 10 * * 5,6,0,1')).toBe('de viernes a lunes a las 10:00');
    expect(scheduleEs('0 23 * * 0-4')).toBe('de domingo a jueves a las 23:00');
    expect(scheduleEs('0 18 * * 1,3')).toBe('los lunes y miércoles a las 18:00');
  });
});
