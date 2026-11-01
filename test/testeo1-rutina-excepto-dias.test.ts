import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// «excepto los domingos» quitaba todos los días menos el domingo: la rutina quedaba
// solo para el día que se había pedido quitar.
describe('rutina: los días quitados con «excepto», «menos» o «salvo»', () => {
  it('«todos los días excepto los domingos» son de lunes a sábado', () => {
    expect(parseNatural('todos los días excepto los domingos a las 9')?.schedule).toBe(
      '0 9 * * 1,2,3,4,5,6',
    );
  });
  it('sin hora también quita el día', () => {
    expect(parseNatural('cada día salvo el sábado riega las plantas')?.schedule).toBe(
      '0 8 * * 0,1,2,3,4,5',
    );
  });
  it('«de lunes a viernes menos el miércoles»', () => {
    expect(
      parseNatural('de lunes a viernes menos el miércoles a las 7:30 gimnasio')?.schedule,
    ).toBe('30 7 * * 1,2,4,5');
  });
  it('varios días quitados', () => {
    expect(
      parseNatural('todos los días a las 8 excepto los sábados y domingos tráfico')?.schedule,
    ).toBe('0 8 * * 1,2,3,4,5');
  });
  it('«a las 9 menos cuarto» sigue siendo una hora', () => {
    expect(parseNatural('cada día a las 9 menos cuarto')?.schedule).toBe('45 8 * * *');
  });
});
