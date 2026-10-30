import { describe, expect, it } from 'vitest';
import { parseKeyChord, winChordVirtualKeys } from '../src/screen/keys.js';

/**
 * Atajos de teclado de Computer Use que el modelo escribe a menudo y salían mal:
 * - «ctrl+A» / «ctrl+C»: SendKeys pulsa Mayús con una letra mayúscula, así que se
 *   mandaba Ctrl+Mayús+A / Ctrl+Mayús+C (en Chrome, las herramientas de
 *   desarrollo en vez de copiar). En un atajo la letra es la tecla.
 * - «ctrl++» (acercar zoom) se rechazaba como «unrecognised key "ctrl"».
 * - «ctrl+{» llegaba a SendKeys sin escapar y fallaba.
 * - «ArrowDown», «PgDn»… (nombres habituales) no se reconocían.
 */
describe('parseKeyChord · atajos habituales', () => {
  it('una letra mayúscula en un atajo no añade Mayús', () => {
    expect(parseKeyChord('ctrl+A')).toBe('^a');
    expect(parseKeyChord('Ctrl+C')).toBe('^c');
    expect(parseKeyChord('ctrl+shift+T')).toBe('^+t');
    expect(parseKeyChord('alt+F')).toBe('%f');
  });

  it('«ctrl++» es Ctrl y la tecla +', () => {
    expect(parseKeyChord('ctrl++')).toBe('^{+}');
    expect(parseKeyChord('ctrl + +')).toBe('^{+}');
    expect(parseKeyChord('ctrl+shift++')).toBe('^+{+}');
  });

  it('las llaves se escapan para SendKeys', () => {
    expect(parseKeyChord('ctrl+{')).toBe('^{{}');
    expect(parseKeyChord('}')).toBe('{}}');
  });

  it('acepta ArrowUp/Down/Left/Right y PgUp/PgDn', () => {
    expect(parseKeyChord('ArrowDown')).toBe('{DOWN}');
    expect(parseKeyChord('shift+ArrowLeft')).toBe('+{LEFT}');
    expect(parseKeyChord('PgDn')).toBe('{PGDN}');
    expect(parseKeyChord('ctrl+pgup')).toBe('^{PGUP}');
    expect(winChordVirtualKeys('win+ArrowUp')).toEqual([0x5b, 0x26]);
  });

  it('lo que ya funcionaba sigue igual (caracterización)', () => {
    expect(parseKeyChord('A')).toBe('A');
    expect(parseKeyChord('+')).toBe('{+}');
    expect(parseKeyChord('ctrl+s')).toBe('^s');
    expect(parseKeyChord('ctrl+-')).toBe('^-');
    expect(parseKeyChord('alt+F4')).toBe('%{F4}');
    expect(() => parseKeyChord('ctrl')).toThrow(/unrecognised key/);
    expect(() => parseKeyChord('ctrlT')).toThrow(/unrecognised key/);
  });
});
