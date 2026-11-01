import { describe, expect, it } from 'vitest';
import { knownKeyNames, parseKeyChord, winChordVirtualKeys } from '../src/screen/keys.js';

/**
 * Atajos que el modelo escribe y que antes fallaban en el PC de Nico:
 * - «printscreen» salía como {PRINTSCREEN}, palabra que SendKeys no conoce
 *   (la suya es {PRTSC}): la tecla Imprimir pantalla siempre daba error.
 * - SendKeys admite F1–F16, pero aquí solo había F1–F12.
 * - «win++» (lupa, acercar) se quedaba en ['win'] y pulsaba solo la tecla
 *   Windows: se abría el menú Inicio. «win+-» se rechazaba.
 * Ningún test pulsa teclas reales.
 */
describe('atajos más allá de F1–F12', () => {
  it('Imprimir pantalla usa la palabra que SendKeys conoce', () => {
    expect(parseKeyChord('printscreen')).toBe('{PRTSC}');
    expect(parseKeyChord('alt+printscreen')).toBe('%{PRTSC}');
    expect(parseKeyChord('prtsc')).toBe('{PRTSC}');
  });

  it('F13–F16, bloq num y bloq despl', () => {
    expect(parseKeyChord('f13')).toBe('{F13}');
    expect(parseKeyChord('shift+F16')).toBe('+{F16}');
    expect(parseKeyChord('numlock')).toBe('{NUMLOCK}');
    expect(parseKeyChord('scrolllock')).toBe('{SCROLLLOCK}');
    expect(knownKeyNames()).toContain('f16');
  });

  it('F17 o más sin tecla Windows se rechaza en vez de teclearse', () => {
    expect(() => parseKeyChord('f17')).toThrow(/unrecognised key/);
  });

  it('«plus» y «minus» como nombres', () => {
    expect(parseKeyChord('ctrl+plus')).toBe('^{+}');
    expect(parseKeyChord('ctrl+minus')).toBe('^-');
  });

  it('«win++» es Windows + «+», no solo la tecla Windows', () => {
    expect(winChordVirtualKeys('win++')).toEqual([0x5b, 0xbb]);
    expect(winChordVirtualKeys('win + +')).toEqual([0x5b, 0xbb]);
    expect(winChordVirtualKeys('win+plus')).toEqual([0x5b, 0xbb]);
    expect(winChordVirtualKeys('win+-')).toEqual([0x5b, 0xbd]);
    expect(winChordVirtualKeys('win+minus')).toEqual([0x5b, 0xbd]);
    expect(winChordVirtualKeys('win+=')).toEqual([0x5b, 0xbb]);
  });

  it('lo que ya funcionaba sigue igual', () => {
    expect(winChordVirtualKeys('win')).toEqual([0x5b]);
    expect(winChordVirtualKeys('win+r')).toEqual([0x5b, 0x52]);
    expect(winChordVirtualKeys('win+f24')).toEqual([0x5b, 0x87]);
    expect(winChordVirtualKeys('win+printscreen')).toEqual([0x5b, 0x2c]);
    expect(winChordVirtualKeys('ctrl++')).toBeNull();
    expect(parseKeyChord('ctrl++')).toBe('^{+}');
    expect(parseKeyChord('+')).toBe('{+}');
    expect(parseKeyChord('f12')).toBe('{F12}');
    expect(() => winChordVirtualKeys('win+ñ')).toThrow(/unrecognised key/);
  });
});
