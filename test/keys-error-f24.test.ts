import { describe, expect, it } from 'vitest';
import { parseKeyChord } from '../src/screen/keys.js';

/**
 * F17–F24 ya funcionan (#939), pero el error de una tecla desconocida seguía
 * diciendo «f1-f16», y el modelo dejaba de intentar F17–F24.
 */
describe('keys: el error de tecla desconocida nombra f1-f24', () => {
  it('una tecla desconocida sugiere f1-f24, no f1-f16', () => {
    expect(() => parseKeyChord('ctrl+f99')).toThrow(/f1-f24/);
    expect(() => parseKeyChord('ctrl+f99')).not.toThrow(/f1-f16/);
  });
});
