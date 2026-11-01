import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas en lenguaje natural (bugs11)', () => {
  it('«8 pm», «7 PM», «8:30 p.m.» son de la tarde; «12 am» es medianoche', () => {
    expect(at('cada día a las 8 pm riega')).toBe('0 20 * * *');
    expect(at('cada día a las 8pm riega')).toBe('0 20 * * *');
    expect(at('cada lunes a las 7 PM gimnasio')).toBe('0 19 * * 1');
    expect(at('todos los días a las 8:30 p.m. cena')).toBe('30 20 * * *');
    expect(at('todos los días a las 12 am copia')).toBe('0 0 * * *');
    expect(at('a las 9 am cada día café')).toBe('0 9 * * *');
    expect(at('cada día a las 9 am y a las 9 pm pastilla')).toBe('0 9,21 * * *');
  });

  it('«cada día laborable» y «los laborables» son de lunes a viernes', () => {
    expect(at('cada día laborable a las 8:15 fichar')).toBe('15 8 * * 1-5');
    expect(at('los laborables a las 7 despierta')).toBe('0 7 * * 1-5');
    expect(at('todos los días laborables a las 9')).toBe('0 9 * * 1-5');
    expect(at('cada día laborable fichar')).toBe('0 8 * * 1-5');
  });

  it('«los findes» es el fin de semana', () => {
    expect(at('los findes a las 11 paseo')).toBe('0 11 * * 0,6');
    expect(at('cada finde a las 10 desayuno')).toBe('0 10 * * 0,6');
  });

  it('«cada segundo martes» o «cada primer lunes de mes» se preguntan, no van todos los días', () => {
    expect(at('cada segundo martes a las 10 reunión')).toBeNull();
    expect(at('cada primer lunes de mes a las 9 reunión')).toBeNull();
    expect(at('el último viernes a las 18 informe')).toBeNull();
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(at('cada día a las 8 y cuarto despierta')).toBe('15 8 * * *');
    expect(at('los días laborables a las 8 fichar')).toBe('0 8 * * 1-5');
    expect(at('los fines de semana a las 10 desayuno')).toBe('0 10 * * 0,6');
    expect(at('cada día a las 9 de la noche apaga la tele')).toBe('0 21 * * *');
    expect(at('el primer día de cada mes a las 9 alquiler')).toBe('0 9 1 * *');
  });
});
