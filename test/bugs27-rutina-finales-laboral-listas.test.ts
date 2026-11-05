import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/**
 * Rutinas: «a final de mes a las 9» sonaba todos los días, «cada día laboral» también, y
 * «los lunes miércoles y viernes» (sin coma) solo sonaba el lunes.
 */
const sched = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: fin de mes, laboral y listas de días sin coma', () => {
  it('fin de mes se pregunta en vez de sonar a diario', () => {
    // bugs30: ahora el último día de cada mes («L»), ya no se pregunta ni suena a diario.
    expect(sched('a final de mes a las 9 cierre')).toBe('0 9 L * *');
    expect(sched('a fin de cada mes a las 9 cierre')).toBe('0 9 L * *');
    expect(sched('a finales de mes a las 9 cierre')).toBeNull();
  });
  it('día laboral = lunes a viernes', () => {
    expect(sched('cada día laboral a las 8 fichar')).toBe('0 8 * * 1-5');
    expect(sched('los días laborales a las 8 fichar')).toBe('0 8 * * 1-5');
  });
  it('lista de días sin comas', () => {
    expect(sched('los lunes miércoles y viernes a las 7 correr')).toBe('0 7 * * 1,3,5');
    expect(sched('los lunes, miércoles y viernes a las 7 correr')).toBe('0 7 * * 1,3,5');
    expect(sched('cada lunes a las 9 informe')).toBe('0 9 * * 1');
  });
});
