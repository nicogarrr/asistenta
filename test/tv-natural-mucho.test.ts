import { describe, expect, it } from 'vitest';
import { BIG_VOLUME_STEP, DEFAULT_VOLUME_STEP, parseTvCommand } from '../src/tv/natural.js';

describe('parseTvCommand: «sube mucho», «baja bastante», «sube un montón» → paso grande', () => {
  it('el paso grande es mayor que el normal y no pasa de 15', () => {
    expect(BIG_VOLUME_STEP).toBe(10);
    expect(BIG_VOLUME_STEP).toBeGreaterThan(DEFAULT_VOLUME_STEP);
  });

  it.each([
    ['sube mucho', 10],
    ['súbele mucho', 10],
    ['súbelo bastante', 10],
    ['sube un montón', 10],
    ['sube muchísimo', 10],
    ['sube mucho el volumen', 10],
    ['sube el volumen mucho', 10],
    ['sube bastante más', 10],
    ['sube mucho la tele', 10],
    ['mucho más volumen', 10],
    ['mucho más alto', 10],
    ['ponla mucho más fuerte', 10],
    ['baja mucho', -10],
    ['bájale bastante', -10],
    ['bájala un montón', -10],
    ['baja bastante el volumen', -10],
    ['baja mucho más', -10],
    ['bastante menos volumen', -10],
    ['mucho más bajo', -10],
  ] as const)('«%s» → paso de %i', (text, steps) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volumeStep', steps });
  });

  it.each([
    ['sube', 3],
    ['sube un poco', 3],
    ['baja más', -3],
    ['más alto', 3],
  ] as const)('sin cambios: «%s» → %i', (text, steps) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volumeStep', steps });
  });

  it.each([
    '¿por qué sube mucho el volumen?',
    '¿cómo se sube mucho el volumen?',
    'el volumen no sube mucho',
    'baja mucho la calidad',
    'sube mucho y pon netflix',
    'mucho',
    'bastante',
  ])('«%s» → al modelo (null)', (text) => {
    expect(parseTvCommand(text)).toBeNull();
  });
});
