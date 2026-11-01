import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: «cada 1 de mes» es un día del mes (bugs12)', () => {
  it('«cada 1 de mes a las 9» suena el día 1, no todos los días', () => {
    expect(at('cada 1 de mes a las 9 paga el alquiler')).toBe('0 9 1 * *');
    expect(at('cada 15 del mes a las 10 factura')).toBe('0 10 15 * *');
    expect(at('todos los 5 de mes a las 8:30 recibo')).toBe('30 8 5 * *');
    expect(at('cada primero de mes a las 9 alquiler')).toBe('0 9 1 * *');
    expect(at('cada 1 de mes paga el alquiler')).toBe('0 8 1 * *');
  });

  it('un día que no existe se pregunta', () => {
    expect(at('cada 32 de mes a las 9 x')).toBeNull();
    expect(at('cada 0 de mes a las 9 x')).toBeNull();
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(at('el 1 de cada mes a las 9 x')).toBe('0 9 1 * *');
    expect(at('cada día 5 a las 9 x')).toBe('0 9 5 * *');
    expect(at('cada 3 meses a las 9 x')).toBeNull();
    expect(at('cada día a las 9 x')).toBe('0 9 * * *');
  });
});
