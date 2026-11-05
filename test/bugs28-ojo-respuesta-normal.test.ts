import { describe, expect, it } from 'vitest';
import { ojoOffAnswer, ojoOnAnswer } from '../src/ojo-respuestas.js';

// bugs28: «¿Lo enciendo?» / «¿Lo apago?» del ojo (Descargas, Pantalla) solo aceptaba una
// palabra suelta; «sí, enciéndelo» o «sí, apágalo» caían al modelo.
describe('ojo: encender o apagar con la respuesta normal', () => {
  it('encender', () => {
    for (const t of ['sí, enciéndelo', 'vale, actívalo', 'sí porfa', 'venga, dale']) {
      expect(ojoOnAnswer(t), t).toBe(true);
    }
    for (const t of ['no', 'apágalo', 'sí, pero mañana', 'qué es esto']) {
      expect(ojoOnAnswer(t), t).toBe(false);
    }
  });

  it('apagar', () => {
    for (const t of ['sí, apágalo', 'apágalo porfa', 'vale, quítalo', 'desactívalo, gracias']) {
      expect(ojoOffAnswer(t), t).toBe(true);
    }
    for (const t of ['no', 'enciéndelo', 'apágalo mañana', 'sí']) {
      expect(ojoOffAnswer(t), t).toBe(false);
    }
  });
});
