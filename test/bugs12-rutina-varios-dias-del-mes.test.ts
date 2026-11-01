import { describe, expect, it } from 'vitest';
import { scheduleEs } from '../src/cron/describe-es.js';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: varios días del mes (bugs12)', () => {
  it('«los días 1 y 15 de cada mes» suena los dos días, no solo el 15', () => {
    expect(at('los días 1 y 15 de cada mes a las 9 revisa cuentas')).toBe('0 9 1,15 * *');
    expect(at('el 1 y el 15 de cada mes a las 10 x')).toBe('0 10 1,15 * *');
    expect(at('cada mes los días 5, 15 y 25 x')).toBe('0 8 5,15,25 * *');
    expect(at('cada 1 y 15 de mes a las 9 x')).toBe('0 9 1,15 * *');
  });

  it('se dice en palabras, no con el cron crudo', () => {
    expect(scheduleEs('0 9 1,15 * *')).toBe('cada mes los días 1 y 15 a las 09:00');
    expect(scheduleEs('30 8 5,15,25 * *')).toBe('cada mes los días 5, 15 y 25 a las 08:30');
    expect(scheduleEs('0 9 1 * *')).toBe('cada mes el día 1 a las 09:00');
  });

  it('un solo día sigue igual; un día imposible se pregunta', () => {
    expect(at('el día 5 de cada mes a las 9 x')).toBe('0 9 5 * *');
    expect(at('los días 1 y 40 de cada mes x')).toBeNull();
  });
});
