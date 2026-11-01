import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';
import { createReminderTool } from '../src/tools/reminder.js';

// gertru-gaps-6: «12 de la noche» en recordatorios y rutinas que se repiten.
describe('rutinas: horas de la noche dichas como se dicen', () => {
  const at = (text: string) => parseNatural(text)?.schedule;

  it('«12 de la noche» y «medianoche» son las 00:00; «mediodía», las 12:00', () => {
    expect(at('todos los días a mediodía comer')).toBe('0 12 * * *');
    expect(at('todos los días a las 12 de la noche tomar la pastilla')).toBe('0 0 * * *');
    expect(at('cada día a medianoche copia de seguridad')).toBe('0 0 * * *');
    expect(at('los lunes a las 12 de la madrugada revisa el correo')).toBe('0 0 * * 1');
  });

  it('«la una de la noche» es la 01:00, no las 13:00', () => {
    expect(at('cada día a la una de la noche apaga el router')).toBe('0 1 * * *');
    expect(at('todos los días a la 1 de la noche apaga el router')).toBe('0 1 * * *');
    expect(at('cada día a las 3 de la madrugada copia')).toBe('0 3 * * *');
  });

  it('la parte del día junto a la hora manda sobre otra palabra de la frase', () => {
    expect(at('cada día a las 8 de la mañana recuérdame lo de esta noche')).toBe('0 8 * * *');
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(at('todos los días a las 9 de la noche saca la basura')).toBe('0 21 * * *');
    expect(at('cada día a las 6 por la tarde riega')).toBe('0 18 * * *');
    expect(at('cada mañana a las 8 resumen del día')).toBe('0 8 * * *');
    expect(at('cada día a las 20:30 resumen')).toBe('30 20 * * *');
  });
});

describe('recordatorios: el modelo sabe qué hora es «12 de la noche»', () => {
  it('la descripción de la herramienta lo dice', () => {
    const tool = createReminderTool({
      store: {} as never,
      scopeOf: () => 's',
    } as never);
    const d = tool.description;
    expect(d).toMatch(/12 de la noche/);
    expect(d).toMatch(/00:00/);
    expect(d).toMatch(/una de la noche/);
  });
});
