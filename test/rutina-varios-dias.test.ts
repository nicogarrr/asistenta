import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

// gertru-gaps-7: «de lunes a viernes a las 8» quedaba cada día, «los lunes y miércoles»
// solo los lunes, y «los sábados por la mañana» sonaba a las 00:00.
describe('rutinas: varios días y partes del día sin hora', () => {
  const at = (text: string) => parseNatural(text)?.schedule;

  it('«de lunes a viernes», «entre semana», «los fines de semana»', () => {
    expect(at('de lunes a viernes a las 8 ficha')).toBe('0 8 * * 1-5');
    expect(at('entre semana a las 7 despiértame')).toBe('0 7 * * 1-5');
    expect(at('los fines de semana a las 10 riega las plantas')).toBe('0 10 * * 0,6');
    expect(at('cada fin de semana a las 11 limpia')).toBe('0 11 * * 0,6');
    expect(at('de martes a sábado a las 10 abre la tienda')).toBe('0 10 * * 2-6');
  });

  it('«los lunes y miércoles», «los lunes, martes y jueves»', () => {
    expect(at('los lunes y miércoles a las 18 gimnasio')).toBe('0 18 * * 1,3');
    expect(at('los lunes, martes y jueves a las 9 inglés')).toBe('0 9 * * 1,2,4');
    expect(at('cada lunes y los jueves a las 9 saca la basura')).toBe('0 9 * * 1,4');
    // Un día que aparece en la tarea no se suma al horario.
    expect(at('cada lunes a las 9 prepara lo del viernes')).toBe('0 9 * * 1');
  });

  it('un día sin hora ya no suena a medianoche', () => {
    expect(at('los sábados por la mañana haz la compra')).toBe('0 8 * * 6');
    expect(at('los lunes revisa el correo')).toBe('0 8 * * 1');
    expect(at('cada día por la tarde riega')).toBe('0 18 * * *');
    expect(at('todas las mañanas resumen')).toBe('0 8 * * *');
    expect(at('los lunes a las 12 de la madrugada revisa el correo')).toBe('0 0 * * 1');
  });

  it('/recordatorios lo dice en castellano', () => {
    expect(scheduleEs('0 10 * * 2-6')).toBe('de martes a sábado a las 10:00');
    expect(scheduleEs('0 18 * * 1,3')).toBe('los lunes y miércoles a las 18:00');
    expect(scheduleEs('0 10 * * 0,6')).toBe('los fines de semana a las 10:00');
  });
});
