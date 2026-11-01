import { describe, expect, it } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';

const SUBE = { action: 'volumeStep', steps: 3 };
const BAJA = { action: 'volumeStep', steps: -3 };

describe('tele: «un poco» antes de «el volumen» es un paso pequeño', () => {
  it.each([
    'baja un poco más el volumen',
    'bájale un poco más el volumen',
    'baja un poquito el volumen',
    'baja un poco el volumen de la tele',
    'bájale un poco',
    'bájale un poco al volumen',
    'baja el volumen un poco más',
  ])('«%s» baja un paso', (frase) => {
    expect(parseTvCommand(frase)).toEqual(BAJA);
  });

  it.each([
    'sube un poco el volumen',
    'súbele un poco más el volumen',
    'sube un poquito más el volumen',
    'súbele un poco al volumen',
    'sube un poco el volumen de la tele',
  ])('«%s» sube un paso', (frase) => {
    expect(parseTvCommand(frase)).toEqual(SUBE);
  });

  it('con número delante de «el volumen» también: «baja dos el volumen», «sube cinco puntos el volumen»', () => {
    expect(parseTvCommand('baja dos el volumen')).toEqual({ action: 'volumeStep', steps: -2 });
    expect(parseTvCommand('sube cinco puntos el volumen')).toEqual({
      action: 'volumeStep',
      steps: 5,
    });
  });

  it('no se inventa nada: «baja un poco la persiana» y órdenes combinadas siguen sin ser de volumen', () => {
    expect(parseTvCommand('baja un poco la persiana')).toBeNull();
    const combinada = parseTvCommand('baja un poco el volumen y pon netflix');
    expect(combinada === null || combinada.action !== 'volumeStep').toBe(true);
  });
});
