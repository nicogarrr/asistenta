import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// bugs29: «todos los días sobre las 9 correo», «hacia las 9», «a eso de las 9» quedaban a las
// 8:00 (la hora por defecto): la hora aproximada no se leía. Y «cada viernes a última hora»
// sonaba a las 8:00 de la mañana.
const at = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: «sobre las 9» es a las 9 (bugs29)', () => {
  it('la hora aproximada cuenta', () => {
    expect(at('todos los días sobre las 9 revisa el correo')).toBe('0 9 * * *');
    expect(at('cada día hacia las 9 y media revisa el correo')).toBe('30 9 * * *');
    expect(at('cada lunes a eso de las 10 informe')).toBe('0 10 * * 1');
    expect(at('cada día alrededor de las 21 resumen')).toBe('0 21 * * *');
    expect(at('todos los días sobre las nueve de la noche resumen')).toBe('0 21 * * *');
  });

  it('«a última hora» sin hora pregunta; «sobre» dentro de la tarea no es una hora', () => {
    expect(at('cada viernes a última hora informe')).toBeNull();
    expect(at('cada viernes a última hora, a las 19, informe')).toBe('0 19 * * 5');
    expect(at('cada lunes a las 9 escribe sobre las ventas')).toBe('0 9 * * 1');
  });
});
