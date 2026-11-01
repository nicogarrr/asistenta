import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  learnNameAnswer,
  PreguntasPendientes,
  SI_RESPUESTA,
} from '../src/daemon/pregunta-pendiente.js';

// Nico (1 nov): «como estamos hablando nosotros». /learn y /routine enseñaban
// «por ejemplo /learn pedir-cita» o «Pásame cada dato así: /routine …». Ahora
// preguntan normal, nombran las rutinas que hay y la respuesta suelta completa la orden.
const cli = readFileSync('src/cli.ts', 'utf8');

describe('/learn y /routine hablan como un amigo', () => {
  it('ya no enseñan comandos con barra de ejemplo', () => {
    for (const viejo of [
      'por ejemplo /learn pedir-cita',
      'Cierra allí con /learn end',
      'Regrábala con /learn.',
      'Pásame cada dato así: /routine',
      'se repite tal cual con /routine',
      'pruébala con /cron probar',
      'la repito cuando quieras con /routine.',
    ]) {
      expect(cli).not.toContain(viejo);
    }
    expect(cli).toContain('`¿Qué rutina repito? Tienes: ${names.slice(0, 10).join(');
  });

  it('el nombre dicho normal sirve para empezar a grabar', () => {
    expect(learnNameAnswer('Pedir cita')).toBe('pedir-cita');
    expect(learnNameAnswer('«Factura del gas».')).toBe('factura-del-gas');
    expect(learnNameAnswer('macro/archiva')).toBe('macro/archiva');
    expect(learnNameAnswer('end')).toBeNull();
    expect(learnNameAnswer('esto es una frase larga que no es un nombre')).toBeNull();
    expect(learnNameAnswer('¿?')).toBeNull();
    const p = new PreguntasPendientes(() => 0);
    p.ask('c', 'learn', { answer: learnNameAnswer });
    expect(p.consume('c', 'Pedir cita')).toEqual({ name: 'learn', args: 'pedir-cita' });
  });

  it('«sí» corto vale; una frase no', () => {
    for (const t of ['sí', 'Si', 'vale', 'venga!', 'ok']) expect(SI_RESPUESTA.test(t)).toBe(true);
    for (const t of ['sí, pero mañana', 'no', 'quizá']) expect(SI_RESPUESTA.test(t)).toBe(false);
  });
});
