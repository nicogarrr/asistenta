import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// asis-bugs-1: «a las 12 de la mañana» salía a medianoche, y «cada 45 minutos» o
// «cada 7 horas» se programaban con un paso de cron que se reinicia cada hora o cada
// día (:00 y :45; 0, 7, 14 y 21 h), así que no salían cada 45 minutos ni cada 7 horas.
const at = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: mediodía e intervalos que no cuadran', () => {
  it('«a las 12 de la mañana» es mediodía; la madrugada y la noche siguen siendo medianoche', () => {
    expect(at('cada día a las 12 de la mañana toma la pastilla')).toBe('0 12 * * *');
    expect(at('los lunes a las doce de la mañana revisa el correo')).toBe('0 12 * * 1');
    expect(at('cada día a las 12 de la madrugada copia')).toBe('0 0 * * *');
    expect(at('cada día a las 12 de la noche copia')).toBe('0 0 * * *');
    expect(at('cada día a las 9 de la mañana resumen')).toBe('0 9 * * *');
  });

  it('un intervalo que no reparte la hora o el día se pregunta en vez de salir torcido', () => {
    expect(at('cada 45 minutos mira el correo')).toBeNull();
    expect(at('cada 7 horas bebe agua')).toBeNull();
    expect(at('cada 90 minutos estira')).toBeNull();
    expect(at('cada 5 horas revisa')).toBeNull();
  });

  it('los intervalos que sí cuadran siguen igual, y 120 minutos son 2 horas', () => {
    expect(at('cada 15 minutos mira el correo')).toBe('*/15 * * * *');
    expect(at('cada 20 minutos mira el correo')).toBe('*/20 * * * *');
    expect(at('cada 2 horas bebe agua')).toBe('0 */2 * * *');
    expect(at('cada 6 horas revisa')).toBe('0 */6 * * *');
    expect(at('cada 120 minutos estira')).toBe('0 */2 * * *');
    expect(at('cada 24 horas copia')).toBe('0 0 * * *');
  });
});
