import { describe, expect, it } from 'vitest';
import {
  esSiRespuesta,
  PreguntasPendientes,
  SI_RESPUESTA,
} from '../src/daemon/pregunta-pendiente.js';

// bugs28: a las preguntas que esperan un sí («¿La activo?», «¿Abro el micro?», «¿La
// pruebo?», «¿Lo reintento?») solo valía una palabra suelta; «sí, hazlo», «si porfa» o
// «vale, gracias» caían al modelo, que no sabía qué se le había preguntado.
describe('preguntas que esperan un sí: el sí dicho con más palabras', () => {
  it('acepta las formas normales', () => {
    for (const t of [
      'sí, hazlo',
      'Si porfa',
      'sí por favor',
      'vale, gracias',
      'claro que sí',
      'sí, actívalo',
      'venga, pruébalo',
      'ok 👍',
      '¡Sí!',
      'de acuerdo',
      'perfecto, adelante',
    ]) {
      expect(SI_RESPUESTA.test(t), t).toBe(true);
    }
  });

  it('lo de antes sigue igual', () => {
    for (const t of ['sí', 'Si', 'vale', 'venga!', 'ok', 'por favor']) {
      expect(esSiRespuesta(t), t).toBe(true);
    }
    for (const t of ['sí, pero mañana', 'no', 'quizá', 'no, gracias', 'sí, no sé', 'gracias', '']) {
      expect(esSiRespuesta(t), t).toBe(false);
    }
  });

  it('completa la pregunta pendiente', () => {
    const p = new PreguntasPendientes();
    p.ask('c', 'rutina', { answer: (t) => (SI_RESPUESTA.test(t) ? 'activar x' : null) });
    expect(p.consume('c', 'sí, hazlo')).toEqual({ name: 'rutina', args: 'activar x' });
  });
});
