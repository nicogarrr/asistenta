import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// «los lunes a las 9 y los jueves a las 5 de la tarde» se guardaba como «solo los lunes a
// las 9»: la segunda parte se perdía sin avisar. Un cron no dice dos horarios distintos,
// así que ahora se pregunta en vez de guardar media rutina.
describe('rutina: dos días con horas distintas no se quedan a medias', () => {
  it('«los lunes a las 9 … y los jueves a las 5 de la tarde» se pregunta', () => {
    expect(
      parseNatural('los lunes a las 9 de la mañana y los jueves a las 5 de la tarde'),
    ).toBeNull();
  });
  it('«el lunes a las 8 gimnasio y el miércoles a las 19» se pregunta', () => {
    expect(parseNatural('los lunes a las 8 gimnasio y los miércoles a las 19')).toBeNull();
  });
  it('varias tomas del mismo día siguen valiendo', () => {
    expect(parseNatural('todos los días a las 9 y a las 21 pastilla')?.schedule).toBe(
      '0 9,21 * * *',
    );
    expect(parseNatural('cada día a las 8, 14 y 20 agua')?.schedule).toBe('0 8,14,20 * * *');
    expect(parseNatural('los martes y jueves a las 18:00')?.schedule).toBe('0 18 * * 2,4');
  });
});
