import { describe, expect, it } from 'vitest';
import { sameToolLimit } from '../src/core/agent.js';

describe('sameToolLimit', () => {
  it('deja a un formulario del navegador rellenar sus campos y enviarlos (K13a)', () => {
    // 5 campos + abrir + mirar + enviar ya pasaban de 10 llamadas seguidas a browser.
    expect(sameToolLimit('browser')).toBeGreaterThanOrEqual(20);
  });

  it('mantiene el limite estricto del resto de herramientas', () => {
    expect(sameToolLimit('shell')).toBe(10);
    expect(sameToolLimit('computer')).toBe(10);
  });
});
