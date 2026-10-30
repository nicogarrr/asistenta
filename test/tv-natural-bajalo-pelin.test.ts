import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

const SUBE = { action: 'volumeStep', steps: 3 };
const BAJA = { action: 'volumeStep', steps: -3 };

describe('tele: «bájalo», «súbelo» y «un pelín» son un paso pequeño de volumen', () => {
  it.each([
    'bájalo',
    'bájalo un poco',
    'bájalo un poco más',
    'baja un pelín',
    'baja un pelín el volumen',
    'bájale un poquitín',
    'baja un pelito más el volumen de la tele',
  ])('«%s» baja un paso', (frase) => {
    expect(parseTvCommand(frase)).toEqual(BAJA);
  });

  it.each([
    'súbelo',
    'súbelo un poco',
    'sube un pelín',
    'súbele un pelín más al volumen',
    'sube un poquitín',
  ])('«%s» sube un paso', (frase) => {
    expect(parseTvCommand(frase)).toEqual(SUBE);
  });

  it('con número: «bájalo dos» baja 2, «súbelo cinco puntos» sube 5', () => {
    expect(parseTvCommand('bájalo dos')).toEqual({ action: 'volumeStep', steps: -2 });
    expect(parseTvCommand('súbelo cinco puntos')).toEqual({ action: 'volumeStep', steps: 5 });
    expect(describeTvIntent(parseTvCommand('bájalo un pelín') as never)).toBe('bajar el volumen 3');
  });

  it('no cambia lo demás: «bájalo y pon netflix» sigue yendo al modelo; «sube un pelo» no es orden', () => {
    const combinada = parseTvCommand('bájalo y pon netflix');
    expect(combinada === null || combinada.action !== 'volumeStep').toBe(true);
    expect(parseTvCommand('sube un pelo')).toBeNull();
  });
});
