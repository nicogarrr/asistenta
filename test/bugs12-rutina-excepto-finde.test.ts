import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const at = (text: string): string | null => parseNatural(text)?.schedule ?? null;

describe('rutinas: «excepto el fin de semana» quita esos días (bugs12)', () => {
  it('«menos el finde» / «excepto los fines de semana» es de lunes a viernes, no solo el finde', () => {
    expect(at('cada día a las 7 menos el finde despierta')).toBe('0 7 * * 1,2,3,4,5');
    expect(at('cada día a las 7 excepto los fines de semana x')).toBe('0 7 * * 1,2,3,4,5');
    expect(at('todos los días salvo el fin de semana a las 8 x')).toBe('0 8 * * 1,2,3,4,5');
    expect(at('cada día a las 7 menos los findes x')).toBe('0 7 * * 1,2,3,4,5');
  });

  it('«excepto entre semana» / «menos los laborables» deja el fin de semana', () => {
    expect(at('cada día a las 10 excepto entre semana x')).toBe('0 10 * * 0,6');
    expect(at('cada día menos los laborables a las 10 x')).toBe('0 10 * * 0,6');
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(at('cada día excepto el domingo a las 9 x')).toBe('0 9 * * 1,2,3,4,5,6');
    expect(at('de lunes a viernes menos el miércoles a las 8 x')).toBe('0 8 * * 1,2,4,5');
    expect(at('los fines de semana a las 10 x')).toBe('0 10 * * 0,6');
    expect(at('entre semana a las 7 x')).toBe('0 7 * * 1-5');
  });
});
