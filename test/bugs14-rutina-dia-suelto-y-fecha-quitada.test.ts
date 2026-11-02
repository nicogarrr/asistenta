import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: «mañana a las 9» y «menos el 25 de diciembre» (bugs14)', () => {
  it('«mañana», «hoy», «esta tarde» al empezar son un día suelto: se pregunta (antes, cada día)', () => {
    expect(at('mañana a las 9 x')).toBeNull();
    expect(at('pasado mañana a las 9 x')).toBeNull();
    expect(at('hoy a las 9 x')).toBeNull();
    expect(at('esta tarde a las 5 x')).toBeNull();
    expect(at('esta noche a las 11 x')).toBeNull();
    expect(at('mañana por la mañana x')).toBeNull();
    expect(at('hoy y mañana a las 9 x')).toBeNull();
  });

  it('quitar una fecha («menos el 25 de diciembre») se pregunta (antes se ignoraba)', () => {
    expect(at('cada dia a las 9 menos el 25 de diciembre x')).toBeNull();
    expect(at('cada lunes a las 9 excepto el 1 de enero x')).toBeNull();
    expect(at('cada día a las 8 salvo el día 15 x')).toBeNull();
  });

  it('sin cambios', () => {
    expect(at('cada día a las 9 dime qué tengo mañana')).toBe('0 9 * * *');
    expect(at('cada mañana x')).toBe('0 8 * * *');
    expect(at('todas las mañanas a las 7:30 x')).toBe('30 7 * * *');
    expect(at('de lunes a viernes a las 7 menos el viernes')).toBe('0 7 * * 1,2,3,4');
    expect(at('cada día a las 9 excepto los domingos x')).toBe('0 9 * * 1,2,3,4,5,6');
  });
});
