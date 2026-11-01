import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';

const TOPE = { action: 'volume', level: 100 };
const MINIMO = { action: 'volume', level: 1 };
const HOME = { action: 'key', name: 'HOME' };

describe('tele: «modo estándar/vivo/eco» son modos de imagen', () => {
  it.each([
    ['modo estándar', 'standard'],
    ['pon el modo estándar', 'standard'],
    ['modo vivo', 'vivid'],
    ['activa el modo vívido', 'vivid'],
    ['pon el modo intenso en la tele', 'vivid'],
    ['modo eco', 'eco'],
    ['pon el modo ahorro de energía', 'eco'],
    ['imagen en modo vivo', 'vivid'],
  ])('«%s» → imagen %s', (frase, mode) => {
    expect(parseTvCommand(frase)).toEqual({ action: 'picture', pictureMode: mode });
  });
  it('«modo normal» a secas sigue yendo al modelo (ambiguo)', () => {
    expect(parseTvCommand('modo normal')).toBeNull();
    expect(parseTvCommand('pon el modo normal')).toBeNull();
  });
  it('«modo eco y pon Netflix» va al modelo (orden combinada)', () => {
    expect(parseTvCommand('modo eco y pon Netflix')).toBeNull();
  });
});

describe('tele: «súbela al máximo», «ponla a tope» → 100', () => {
  it.each([
    'súbela al máximo',
    'súbelo a tope',
    'súbela a tope',
    'ponla a tope',
    'ponlo al máximo',
    'pon la tele a tope',
    'pon la tele al máximo',
    'sube la tele a tope',
    'oye, súbela a tope',
  ])('«%s» → volumen 100', (frase) => {
    expect(parseTvCommand(frase)).toEqual(TOPE);
  });
});

describe('tele: «bájala a tope» → mínimo (1), nunca silencio', () => {
  it.each([
    'bájala a tope',
    'bájalo a tope',
    'baja a tope',
    'baja el volumen a tope',
    'bájala al máximo',
    'baja la tele a tope',
    'bájala al mínimo',
  ])('«%s» → volumen 1', (frase) => {
    expect(parseTvCommand(frase)).toEqual(MINIMO);
  });
});

describe('tele: «ve a inicio» → tecla HOME', () => {
  it.each([
    've a inicio',
    've al inicio',
    'vete al inicio',
    'vuelve al inicio',
    'volver a inicio',
    'ir al inicio',
    'inicio',
    'pulsa inicio',
    'dale al botón de inicio',
    'pulsa el botón home',
    'pantalla de inicio',
    've a la pantalla de inicio',
    'menú de inicio',
    'home',
    've al inicio en la tele',
  ])('«%s» → HOME', (frase) => {
    expect(parseTvCommand(frase)).toEqual(HOME);
  });
  it('se describe como «ir a la pantalla de inicio»', () => {
    expect(describeTvIntent({ action: 'key', name: 'HOME' })).toBe('ir a la pantalla de inicio');
  });
  it('«atrás» sigue siendo BACK y se describe igual', () => {
    expect(parseTvCommand('vuelve atrás')).toEqual({ action: 'key', name: 'BACK' });
    expect(describeTvIntent({ action: 'key', name: 'BACK' })).toBe('volver atrás');
  });
  it('«ve a inicio y pon Netflix» va al modelo (orden combinada)', () => {
    expect(parseTvCommand('ve a inicio y pon Netflix')).toBeNull();
  });
});
