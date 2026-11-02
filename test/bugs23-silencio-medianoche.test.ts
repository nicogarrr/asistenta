/**
 * «No me escribas después de las 12 (de la noche)» y «… después de la 1 de la madrugada»:
 * la hora se leía como las 12:00 (mediodía) o las 13:00, el silencio salía de más de 16 h
 * y se descartaba entero, así que el vigilante y el resumen seguían con el horario de serie.
 * Ahora las 12 de la noche son las 00:00 y la madrugada no suma 12 (como /calendario).
 */
import { describe, expect, it } from 'vitest';
import { ownerQuietHours, ownerStatedQuiet } from '../src/memory/owner-quiet.js';

const said = (t: string) => `[dicho] ${t}`;

describe('silencio dicho por el dueño: medianoche y madrugada', () => {
  it('«después de las 12 de la noche» empieza a las 00:00', () => {
    expect(ownerStatedQuiet([said('no me escribas después de las 12 de la noche')])).toEqual({
      startHour: 0,
      endHour: 8,
    });
  });

  it('«después de las 12» a secas también es la medianoche', () => {
    expect(ownerStatedQuiet([said('no me mandes nada después de las 12')])).toEqual({
      startHour: 0,
      endHour: 8,
    });
  });

  it('«después de la 1 de la madrugada» es la 01:00, no las 13:00', () => {
    expect(ownerStatedQuiet([said('no me escribas después de la 1 de la madrugada')])).toEqual({
      startHour: 1,
      endHour: 8,
    });
  });

  it('con el final dicho también: «antes de las 9» + «a partir de las 12 de la noche»', () => {
    expect(
      ownerQuietHours([
        said('no me escribas antes de las 9'),
        said('no me escribas a partir de las 12 de la noche'),
      ]),
    ).toEqual({ startHour: 0, endHour: 9 });
  });

  it('lo de antes no cambia', () => {
    expect(ownerStatedQuiet([said('no me escribas después de las 11')])).toEqual({
      startHour: 23,
      endHour: 8,
    });
    expect(ownerStatedQuiet([said('no me escribas antes de las 12')])).toEqual({
      startHour: 22,
      endHour: 12,
    });
    expect(ownerStatedQuiet([said('no me escribas después de las 10 de la noche')])).toEqual({
      startHour: 22,
      endHour: 8,
    });
  });
});
