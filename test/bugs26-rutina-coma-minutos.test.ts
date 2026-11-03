import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

/**
 * Rutinas: «cada día a las 9,30 pastilla», «a las 9'30» o «a las 21,15» sonaban a las 9:00 /
 * 21:00 sin avisar (los minutos tras coma o apóstrofo se perdían), y «a las 9,10,11 agua»
 * perdía la toma de las 11.
 */
const sched = (text: string) => parseNatural(text)?.schedule ?? null;

describe('rutinas: minutos tras coma o apóstrofo y listas con comas', () => {
  it('coma o apóstrofo con minutos que no pueden ser otra hora', () => {
    expect(sched('cada día a las 9,30 pastilla')).toBe('30 9 * * *');
    expect(sched("cada día a las 9'30 pastilla")).toBe('30 9 * * *');
    expect(sched('cada día a las 9’45 pastilla')).toBe('45 9 * * *');
    expect(sched('cada día a las 9,30h pastilla')).toBe('30 9 * * *');
    expect(sched('cada lunes a las 18,30 inglés')).toBe('30 18 * * 1');
    expect(sched("cada día a las 21'15 pastilla")).toBe('15 21 * * *');
  });

  it('con coma y un número que también podría ser una hora, pregunta', () => {
    expect(sched('cada día a las 9,15 pastilla')).toBeNull();
    expect(sched('cada día a las 21,15 pastilla')).toBeNull();
    expect(sched('cada día a las 9,5 pastilla')).toBeNull();
  });

  it('listas de horas con comas', () => {
    expect(sched('cada día a las 9,10,11 agua')).toBe('0 9,10,11 * * *');
    expect(sched('cada día a las 9,10 y 11 agua')).toBe('0 9,10,11 * * *');
    expect(sched('cada día a las 8, 14, 20 pastilla')).toBe('0 8,14,20 * * *');
    expect(sched('cada día a las 9, 10 y 11 agua')).toBe('0 9,10,11 * * *');
  });

  it('lo de siempre no cambia', () => {
    expect(sched('cada día a las 9.30 pastilla')).toBe('30 9 * * *');
    expect(sched('cada día a las 9:30 pastilla')).toBe('30 9 * * *');
    expect(sched('cada día a las 9, pastilla')).toBe('0 9 * * *');
    expect(sched('cada día a las 8, 20 minutos de paseo')).toBe('0 8 * * *');
    expect(sched('cada día a las 8 de la mañana 2 pastillas')).toBe('0 8 * * *');
  });
});
