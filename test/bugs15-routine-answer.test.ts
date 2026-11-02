import { describe, expect, it } from 'vitest';
import { PreguntasPendientes, routineNameAnswer } from '../src/daemon/pregunta-pendiente.js';

describe('«¿Qué rutina repito?»: la respuesta dicha normal encuentra la rutina', () => {
  const names = ['pedir-cita', 'factura-del-gas', 'macro/archiva', 'informe'];
  const answer = routineNameAnswer(names);

  it('como se dice al hablar: espacios, mayúsculas, tildes, comillas y punto', () => {
    expect(answer('Pedir cita')).toBe('pedir-cita');
    expect(answer('pedir-cita')).toBe('pedir-cita');
    expect(answer('«Factura del gás».')).toBe('factura-del-gas');
    expect(answer('Informe!')).toBe('informe');
    expect(answer('“informe”')).toBe('informe');
    expect(answer('macro/archiva')).toBe('macro/archiva');
  });

  it('lo que no es una de sus rutinas no se toma por respuesta', () => {
    expect(answer('pedir')).toBeNull();
    expect(answer('otra cosa distinta')).toBeNull();
    expect(answer('¿?')).toBeNull();
  });

  it('un nombre guardado con tilde también se encuentra sin ella', () => {
    expect(routineNameAnswer(['revisión'])('revision')).toBe('revisión');
  });

  it('por la pregunta pendiente llega el nombre guardado tal cual', () => {
    const p = new PreguntasPendientes(() => 0);
    p.ask('c', 'routine', { answer: answer });
    expect(p.consume('c', 'Factura del gas')).toEqual({ name: 'routine', args: 'factura-del-gas' });
  });
});
