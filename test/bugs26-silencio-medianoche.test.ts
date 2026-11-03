import { describe, expect, it } from 'vitest';
import { SAID_PREFIX } from '../src/memory/owner-facts.js';
import { ownerQuietHours, ownerStatedQuiet } from '../src/memory/owner-quiet.js';

/**
 * «No me escribas después de medianoche» se apuntaba («📝 Apuntado») pero las horas de
 * silencio no lo leían: seguían las de serie (22–8) y a las 23 llegaban avisos que él no
 * había vetado, o al revés. Ahora medianoche son las 0.
 */
const said = (s: string) => `${SAID_PREFIX} ${s}`;

describe('horas de silencio con «medianoche»', () => {
  it('después de / a partir de medianoche empieza a las 0', () => {
    for (const s of [
      'No me escribas después de medianoche',
      'No me escribas después de la medianoche',
      'No me mandes nada a partir de medianoche',
    ]) {
      expect(ownerStatedQuiet([said(s)]), s).toEqual({ startHour: 0, endHour: 8 });
    }
  });

  it('con las dos horas y en franja', () => {
    expect(
      ownerStatedQuiet([said('No me escribas después de medianoche ni antes de las 7')]),
    ).toEqual({ startHour: 0, endHour: 7 });
    expect(ownerStatedQuiet([said('No me escribas entre la medianoche y las 7')])).toEqual({
      startHour: 0,
      endHour: 7,
    });
    expect(ownerStatedQuiet([said('No me escribas de medianoche a 9')])).toEqual({
      startHour: 0,
      endHour: 9,
    });
  });

  it('lo de siempre no cambia', () => {
    expect(ownerQuietHours([said('No me escribas después de las 12')])).toEqual({
      startHour: 0,
      endHour: 8,
    });
    expect(ownerQuietHours([said('No me escribas después de las 11')])).toEqual({
      startHour: 23,
      endHour: 8,
    });
    expect(ownerStatedQuiet([said('Mi gato se llama Medianoche')])).toBeNull();
  });
});
