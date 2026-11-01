import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas con fin («durante una semana», «hasta el viernes») (bugs12)', () => {
  it('se preguntan: un cron no tiene fin y antes sonaban para siempre', () => {
    expect(at('cada día a las 9 durante una semana tómate el antibiótico')).toBeNull();
    expect(at('cada día a las 9 durante 10 días x')).toBeNull();
    expect(at('cada 8 horas durante dos semanas x')).toBeNull();
    expect(at('cada día a las 9 hasta el viernes x')).toBeNull();
    expect(at('cada lunes a las 10 hasta fin de mes x')).toBeNull();
    expect(at('cada día a las 21 hasta mañana x')).toBeNull();
    expect(at('cada hora hasta el final de la semana x')).toBeNull();
  });

  it('una franja «hasta las 20» o «durante la mañana» no es un fin', () => {
    expect(at('cada hora desde las 8 hasta las 20 x')).toBe('0 8-20 * * *');
    expect(at('cada hora de 9 hasta 18 x')).toBe('0 9-18 * * *');
    expect(at('cada día a las 9 x')).toBe('0 9 * * *');
    expect(at('cada lunes durante el día a las 9 x')).toBe('0 9 * * 1');
    expect(at('cada lunes a las 9 cuenta los días hasta el 25 de diciembre')).toBe('0 9 * * 1');
  });
});
