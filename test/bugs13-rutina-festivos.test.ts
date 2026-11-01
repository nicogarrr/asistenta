import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas con festivos («excepto festivos») (bugs13)', () => {
  it('se preguntan: un cron no sabe qué días son festivos y antes sonaban también en festivo', () => {
    expect(at('cada lunes a las 9 excepto festivos')).toBeNull();
    expect(at('de lunes a viernes a las 7 salvo los festivos abre la persiana')).toBeNull();
    expect(at('cada día laborable a las 8 menos los días festivos')).toBeNull();
    expect(at('cada día a las 9 que no sea festivo')).toBeNull();
    expect(at('cada día a las 9 sin contar festivos')).toBeNull();
    expect(at('los festivos a las 10 haz paella')).toBeNull();
  });

  it('«festivos» como parte de la tarea no cambia nada', () => {
    expect(at('cada día a las 9 revisa el calendario de festivos')).toBe('0 9 * * *');
    expect(at('cada lunes a las 9 dime los festivos de la semana')).toBe('0 9 * * 1');
    expect(at('de lunes a viernes a las 7 menos el viernes')).toBe('0 7 * * 1,2,3,4');
  });
});
