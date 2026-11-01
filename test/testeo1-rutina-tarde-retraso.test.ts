import { describe, expect, it } from 'vitest';
import { parseNatural } from '../src/cron/scheduler.js';

// «tarde» de «llegar tarde» y «noche» dentro de «anoche» no son la tarde ni la noche:
// la rutina se movía doce horas (a las 7 → 19:00) sin que nadie lo hubiera dicho.
describe('rutina: «tarde» como «con retraso» no cambia la hora', () => {
  it('«no llegar tarde» deja las 7 de la mañana', () => {
    expect(
      parseNatural('todos los días a las 7 recuérdame no llegar tarde al trabajo')?.schedule,
    ).toBe('0 7 * * *');
  });
  it('«si voy tarde» deja las 8', () => {
    expect(parseNatural('cada día a las 8 dime si voy tarde')?.schedule).toBe('0 8 * * *');
  });
  it('«anoche» no es «noche»', () => {
    expect(parseNatural('todos los días a las 7 lee el resumen de anoche')?.schedule).toBe(
      '0 7 * * *',
    );
  });
  it('la tarde y la noche dichas siguen moviendo la hora', () => {
    expect(parseNatural('todos los días a las 6 riega por la tarde')?.schedule).toBe('0 18 * * *');
    expect(parseNatural('cada día a las 10 recuérdame sacar al perro por la noche')?.schedule).toBe(
      '0 22 * * *',
    );
    expect(
      parseNatural('todos los días a las 7 avísame para la cena de esta noche')?.schedule,
    ).toBe('0 19 * * *');
    expect(parseNatural('los lunes a las 5 repasa las tardes de la semana')?.schedule).toBe(
      '0 17 * * 1',
    );
  });
});
