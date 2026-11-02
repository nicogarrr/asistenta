import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas con inicio o fin por mes («a partir de marzo», «hasta marzo») (bugs14)', () => {
  it('se preguntan: antes sonaban ya y para siempre', () => {
    expect(at('cada lunes a las 9 a partir de marzo riega las plantas')).toBeNull();
    expect(at('cada lunes a las 9 desde marzo riega')).toBeNull();
    expect(at('cada lunes a las 9 hasta marzo riega')).toBeNull();
    expect(at('a partir de marzo, cada lunes a las 9 riega')).toBeNull();
    expect(at('cada día a las 8 hasta finales de junio x')).toBeNull();
    expect(at('cada día a las 8 hasta el mes de junio x')).toBeNull();
    expect(at('cada lunes a las 9 cuenta los días hasta marzo')).toBeNull();
  });

  it('una fecha de inicio o fin dicha con el horario también se pregunta', () => {
    expect(at('cada día a las 8 hasta el 15 de marzo toma la pastilla')).toBeNull();
    expect(at('cada día a las 8 a partir del 1 de diciembre x')).toBeNull();
    expect(at('desde el 1 de diciembre, cada lunes a las 9 x')).toBeNull();
    expect(at('cada día a las 8 de la tarde hasta el 3 de enero x')).toBeNull();
    expect(at('cada día a las 8 hasta 2027 x')).toBeNull();
  });

  it('un rango de meses o una fecha dentro de la tarea no cambian', () => {
    expect(at('cada lunes a las 9 desde marzo hasta mayo x')).toBe('0 9 * 3-5 1');
    expect(at('cada lunes a las 9 de marzo a mayo x')).toBe('0 9 * 3-5 1');
    expect(at('cada lunes a las 9 cuenta los días hasta el 25 de diciembre')).toBe('0 9 * * 1');
    expect(at('cada hora desde las 8 hasta las 20 x')).toBe('0 8-20 * * *');
    expect(at('cada 1 de marzo a las 9 paga el seguro')).toBe('0 9 1 3 *');
  });
});
