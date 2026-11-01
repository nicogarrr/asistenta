import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: «tres veces al día» (bugs12)', () => {
  it('con menos horas que veces se pregunta, no suena una sola vez', () => {
    expect(at('tres veces al día a las 8 bebe agua')).toBeNull();
    expect(at('cada día dos veces estira')).toBeNull();
    expect(at('dos veces al día a las 9 pastilla')).toBeNull();
  });

  it('con tantas horas como veces vale', () => {
    expect(at('tres veces al día a las 8, 14 y 20 pastilla')).toBe('0 8,14,20 * * *');
    expect(at('dos veces al día a las 9 y a las 21 pastilla')).toBe('0 9,21 * * *');
  });

  it('«al mediodía y a medianoche» son las dos horas', () => {
    expect(at('cada día al mediodía y a medianoche copia')).toBe('0 0,12 * * *');
    expect(at('cada día a medianoche copia')).toBe('0 0 * * *');
    expect(at('cada día al mediodía come')).toBe('0 12 * * *');
  });
});
