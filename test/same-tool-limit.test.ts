import { describe, expect, it } from 'vitest';
import { sameToolLimit } from '../src/core/agent.js';

describe('sameToolLimit', () => {
  it('deja a un formulario del navegador rellenar sus campos y enviarlos (K13a)', () => {
    // 5 campos + abrir + mirar + enviar pasaban de 10; en la bateria F1-F16 (5 oct) 4 runs de browser (Renfe, ALSA, Booking, mesa) chocaron con 25.
    expect(sameToolLimit('browser')).toBeGreaterThanOrEqual(40);
  });

  it('mantiene el limite estricto del resto de herramientas', () => {
    expect(sameToolLimit('shell')).toBe(10);
    expect(sameToolLimit('computer')).toBe(10);
  });
});
