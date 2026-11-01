import { describe, expect, it } from 'vitest';
import { parseTvCommand, VOLUME_MINIMO, VOLUME_TOPE } from '../src/tv/natural.js';

// «baja el volumen del todo» iba al modelo. «Del todo» es lo mismo que «a tope».
describe('volumen «del todo»', () => {
  it.each([
    ['sube el volumen del todo', VOLUME_TOPE],
    ['súbela del todo', VOLUME_TOPE],
    ['sube del todo', VOLUME_TOPE],
    ['baja el volumen del todo', VOLUME_MINIMO],
    ['bájalo del todo', VOLUME_MINIMO],
    ['baja del todo', VOLUME_MINIMO],
  ])('«%s» → %i', (text, level) => {
    expect(parseTvCommand(text)).toEqual({ action: 'volume', level });
  });

  it('«apaga del todo» no toca el volumen', () => {
    expect(parseTvCommand('apaga del todo')).toBeNull();
  });
});
