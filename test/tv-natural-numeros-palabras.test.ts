import { describe, expect, it } from 'vitest';
import { parseTvCommand, spanishNumber } from '../src/tv/natural.js';

describe('tele: números en palabras y «un poco más»', () => {
  it('ANTES «volumen a treinta y cinco» ponía 30 en silencio; ahora pone 35', () => {
    expect(parseTvCommand('volumen a treinta y cinco')).toEqual({ action: 'volume', level: 35 });
    expect(parseTvCommand('pon el volumen a cuarenta y dos')).toEqual({
      action: 'volume',
      level: 42,
    });
  });

  it('números en palabras que antes no se entendían (veinticinco, doce, dieciocho, cien)', () => {
    expect(parseTvCommand('volumen a veinticinco')).toEqual({ action: 'volume', level: 25 });
    expect(parseTvCommand('pon el volumen a doce')).toEqual({ action: 'volume', level: 12 });
    expect(parseTvCommand('volumen al dieciocho')).toEqual({ action: 'volume', level: 18 });
    expect(parseTvCommand('volumen a cien')).toEqual({ action: 'volume', level: 100 });
    expect(parseTvCommand('baja el volumen a veintitrés')).toEqual({ action: 'volume', level: 23 });
  });

  it('paso relativo en palabras: «sube el volumen doce», «baja veinticinco» se recorta y lo dice', () => {
    expect(parseTvCommand('sube el volumen doce')).toEqual({ action: 'volumeStep', steps: 12 });
    expect(parseTvCommand('baja veinticinco')).toEqual({
      action: 'volumeStep',
      steps: -15,
      requested: 25,
    });
  });

  it('«sube un poco más» / «bájale un poquito más» es un paso corto, no null', () => {
    expect(parseTvCommand('sube un poco más')).toEqual({ action: 'volumeStep', steps: 3 });
    expect(parseTvCommand('bájale un poquito más')).toEqual({ action: 'volumeStep', steps: -3 });
    expect(parseTvCommand('sube el volumen un poco más')).toEqual({
      action: 'volumeStep',
      steps: 3,
    });
  });

  it('canal en palabras más allá de diez: «canal doce», «pon la once»', () => {
    expect(parseTvCommand('canal doce')).toEqual({ action: 'channel', channel: '12' });
    expect(parseTvCommand('pon la once')).toEqual({ action: 'channel', channel: '11' });
  });

  it('lo que ya iba sigue igual (y nada se inventa)', () => {
    expect(parseTvCommand('volumen a treinta')).toEqual({ action: 'volume', level: 30 });
    expect(parseTvCommand('volumen a 20')).toEqual({ action: 'volume', level: 20 });
    expect(parseTvCommand('sube cinco')).toEqual({ action: 'volumeStep', steps: 5 });
    expect(parseTvCommand('pon el canal cinco')).toEqual({ action: 'channel', channel: '5' });
    expect(parseTvCommand('volumen a ciento cincuenta')).toBeNull();
    expect(parseTvCommand('pon la tele')).not.toEqual(
      expect.objectContaining({ action: 'channel' }),
    );
  });

  it('spanishNumber: 0–100, nada fuera ni palabras sueltas', () => {
    expect(spanishNumber('cero')).toBe(0);
    expect(spanishNumber('dieciseis')).toBe(16);
    expect(spanishNumber('veintiun')).toBe(21);
    expect(spanishNumber('noventa y nueve')).toBe(99);
    expect(spanishNumber('treinta y')).toBeNull();
    expect(spanishNumber('veinte y cinco')).toBeNull();
    expect(spanishNumber('netflix')).toBeNull();
    expect(spanishNumber('7')).toBe(7);
  });
});
