import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

const sched = (s: string): string | null => parseNatural(s)?.schedule ?? null;

describe('rutinas con dos horas: la segunda no se pierde', () => {
  it('«a las 9 y a las 21» son las dos tomas', () => {
    // Antes: «0 9 * * *» y la toma de la noche desaparecía sin avisar.
    expect(sched('cada día a las 9 y a las 21 pastilla')).toBe('0 9,21 * * *');
    expect(sched('todos los días a las 10 y a las 22 insulina')).toBe('0 10,22 * * *');
    expect(sched('cada día a las 9 de la mañana y a las 9 de la noche pastilla')).toBe(
      '0 9,21 * * *',
    );
    expect(sched('cada día a las 8:00 y a las 20:00 pastilla')).toBe('0 8,20 * * *');
    expect(sched('cada lunes a las 9 y a las 18 fichar')).toBe('0 9,18 * * 1');
    expect(sched('cada día a las 8, 14 y 20 pastilla')).toBe('0 8,14,20 * * *');
    expect(sched('cada día a las 8, a las 14 y a las 20 pastilla')).toBe('0 8,14,20 * * *');
  });

  it('con minutos distintos un cron no lo dice: se pregunta', () => {
    expect(sched('cada día a las 8:30 y a las 20:00 pastilla')).toBeNull();
  });

  it('lo de siempre sigue igual', () => {
    expect(sched('cada día a las 8 y 20 pastilla')).toBe('20 8 * * *');
    expect(sched('cada día a las 9 y media resumen')).toBe('30 9 * * *');
    expect(sched('cada martes a las 7 de la tarde basura')).toBe('0 19 * * 2');
    expect(sched('cada día a las 6 riega por la tarde')).toBe('0 18 * * *');
    // Una hora dentro de lo que hay que recordar no es otra toma.
    expect(sched('cada día a las 9 recuérdame que la farmacia abre a las 10')).toBe('0 9 * * *');
    expect(sched('cada día a las 8, 20 minutos de paseo')).toBe('0 8 * * *');
  });
});
