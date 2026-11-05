import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// bugs29: «cada laborable a las 9 fichar» y «los días de semana a las 9» sonaban también el
// sábado y el domingo («0 9 * * *»).
const at = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: «cada laborable» y «días de semana» son de lunes a viernes (bugs29)', () => {
  it('de lunes a viernes', () => {
    expect(at('cada laborable a las 9 fichar')).toBe('0 9 * * 1-5');
    expect(at('los días de semana a las 9 fichar')).toBe('0 9 * * 1-5');
    expect(at('todos los días de semana a las 8:30 tren')).toBe('30 8 * * 1-5');
  });

  it('lo que ya iba no cambia', () => {
    expect(at('los laborables a las 9 fichar')).toBe('0 9 * * 1-5');
    expect(at('cada día laborable a las 9 fichar')).toBe('0 9 * * 1-5');
    expect(at('cada día de la semana a las 9 pastilla')).toBe('0 9 * * *');
    expect(at('a diario a las 9 pastilla')).toBe('0 9 * * *');
    expect(at('todos los días a las 9 pastilla')).toBe('0 9 * * *');
    expect(at('cada semana a las 9 informe')).toBe('0 9 * * 1');
  });
});
