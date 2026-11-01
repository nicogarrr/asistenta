import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: «lunes a viernes» y «días hábiles» (bugs12)', () => {
  it('«lunes a viernes» sin «de» son esos días, no todos', () => {
    expect(at('lunes a viernes a las 8 fichar')).toBe('0 8 * * 1-5');
    expect(at('cada semana lunes a jueves a las 7 x')).toBe('0 7 * * 1-4');
    expect(at('del lunes al viernes a las 8 x')).toBe('0 8 * * 1-5');
  });

  it('«días hábiles» y «de diario» son de lunes a viernes', () => {
    expect(at('todos los días hábiles a las 8 x')).toBe('0 8 * * 1-5');
    expect(at('cada día hábil a las 9 x')).toBe('0 9 * * 1-5');
    expect(at('cada día de diario a las 8 x')).toBe('0 8 * * 1-5');
  });

  it('«cada lunes y cada jueves» son los dos días, no solo el lunes', () => {
    expect(at('cada lunes y cada jueves a las 9 x')).toBe('0 9 * * 1,4');
    expect(at('los lunes y los jueves a las 9 x')).toBe('0 9 * * 1,4');
    expect(at('cada lunes, cada miércoles y cada viernes a las 7 x')).toBe('0 7 * * 1,3,5');
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(at('de lunes a viernes a las 8 x')).toBe('0 8 * * 1-5');
    expect(at('el lunes a las 9 y el viernes a las 9 x')).not.toBe('0 9 * * 1-5');
    expect(at('cada lunes a las 9 x')).toBe('0 9 * * 1');
    expect(at('cada día a las 8 x')).toBe('0 8 * * *');
  });
});
