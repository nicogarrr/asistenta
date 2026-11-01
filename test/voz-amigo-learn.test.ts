import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEARN_END_RESPUESTA, LearnRecorder } from '../src/learn.js';

// Nico (1 nov): «como estamos hablando nosotros». Al grabar una rutina se pedía
// «cuando termines, /learn end» y al guardarla «La ejecutas con /routine X a=...».
// Ahora basta con decir «ya está», y al guardarla pregunta si la prueba.
const cli = readFileSync('src/cli.ts', 'utf8');
const web = readFileSync('src/teach-demo-web.ts', 'utf8');

describe('/learn se cierra hablando normal', () => {
  it('«ya está», «listo», «he terminado»… cierran; una frase de la demo no', () => {
    for (const t of [
      'ya está',
      'Ya esta.',
      'listo',
      'Listo!',
      'he terminado',
      'ya he acabado',
      'terminé',
      'ya acabé',
      'fin',
      'deja de grabar',
    ]) {
      expect(LEARN_END_RESPUESTA.test(t), t).toBe(true);
    }
    for (const t of [
      'ya está el correo enviado',
      'listo para enviar a Juan',
      'ya',
      'abre la web del banco',
      'no he terminado',
      'end',
    ]) {
      expect(LEARN_END_RESPUESTA.test(t), t).toBe(false);
    }
  });

  it('el grabador dice si hay una grabación en curso en el chat', () => {
    const r = new LearnRecorder();
    const agent = { messages: [], compactions: 0 };
    expect(r.isRecording('c')).toBe(false);
    r.start('c', 'pedir-cita', 't', agent);
    expect(r.isRecording('c')).toBe(true);
    expect(r.isRecording('otro')).toBe(false);
    r.end('c', 't', agent);
    expect(r.isRecording('c')).toBe(false);
  });

  it('el chat cierra la grabación con esas palabras y ya no enseña comandos', () => {
    expect(cli).toContain('if (LEARN_END_RESPUESTA.test(inbound.text.trim())) {');
    expect(cli).toContain("await cmdLearn(learnThread, inbound, 'end');");
    for (const viejo of [
      'cuando termines, /learn end.',
      'La ejecutas con /routine',
      'Replaying con /routine',
    ]) {
      expect(cli).not.toContain(viejo);
    }
    expect(web).not.toContain('cuando acabes, /learn end.');
    expect(cli).toContain('cuando termines, dime «ya está».');
    expect(web).toContain('cuando acabes, dime «ya está».');
    expect(cli).toContain('guardada. ¿La repito ahora? Dime «sí».');
  });
});
