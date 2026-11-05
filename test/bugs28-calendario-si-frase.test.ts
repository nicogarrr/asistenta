import { describe, expect, it } from 'vitest';
import { esSiCalendario } from '../src/agenda/calendario-pasado.js';

// bugs28: a «¿Lo apunto igualmente?» de /calendario solo valía una palabra suelta («sí»).
// «sí, apúntalo» o «si porfa» caían al modelo y el evento no se apuntaba.
describe('/calendario: la respuesta normal a «¿Lo apunto igualmente?»', () => {
  it('acepta un «sí» dicho con más palabras', () => {
    for (const t of [
      'sí, apúntalo',
      'Si porfa',
      'sí por favor',
      'vale, gracias',
      'claro que sí',
      'Sí, apúntalo igualmente',
      'venga, ponlo',
      'ok 👍',
      '¡Sí!',
      'de acuerdo, sí',
    ]) {
      expect(esSiCalendario(t), t).toBe(true);
    }
  });

  it('sigue aceptando las palabras sueltas de antes', () => {
    for (const t of ['sí', 'vale', 'apúntalo', 'igualmente', 'ok.']) {
      expect(esSiCalendario(t), t).toBe(true);
    }
  });

  it('no confunde un «no» ni otra fecha con un sí', () => {
    for (const t of [
      'no',
      'no, gracias',
      'sí pero mañana a las 10',
      'el 6 de noviembre a las 10',
      'mejor no',
      'sí, no sé',
      'gracias',
    ]) {
      expect(esSiCalendario(t), t).toBe(false);
    }
  });
});
