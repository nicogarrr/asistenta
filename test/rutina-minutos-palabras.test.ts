import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// gertru-gaps-7: «a las ocho y diez» quedaba a las 8:00 (los minutos en palabras se perdían).
describe('rutinas: minutos dichos en palabras', () => {
  const at = (text: string) => parseNatural(text)?.schedule;

  it('«y diez», «y veinte», «y cinco», «y veinticinco», «y cuarenta»', () => {
    expect(at('cada día a las ocho y diez toma la pastilla')).toBe('10 8 * * *');
    expect(at('todos los lunes a las 9 y veinte reunión')).toBe('20 9 * * 1');
    expect(at('cada día a las siete y cinco despiértame')).toBe('5 7 * * *');
    expect(at('cada día a las 6 y veinticinco de la tarde riega')).toBe('25 18 * * *');
    expect(at('cada día a las 10 y cuarenta y cinco estira')).toBe('45 10 * * *');
    expect(at('cada día a las 10 y cuarenta estira')).toBe('40 10 * * *');
  });

  it('«menos veinte», «menos diez», «menos cinco»', () => {
    expect(at('cada día a las nueve menos veinte sal de casa')).toBe('40 8 * * *');
    expect(at('los viernes a las 3 menos diez de la tarde llama')).toBe('50 14 * * 5');
    expect(at('cada día a la una menos cinco comer')).toBe('55 0 * * *');
  });

  it('«en punto» no rompe la parte del día', () => {
    expect(at('cada día a las ocho en punto de la tarde cena')).toBe('0 20 * * *');
  });

  it('una «y» que sigue con la tarea no se lee como minutos', () => {
    expect(at('cada día a las 8 y revisa el correo')).toBe('0 8 * * *');
    expect(at('cada día a las 8 y media revisa el correo')).toBe('30 8 * * *');
  });
});
