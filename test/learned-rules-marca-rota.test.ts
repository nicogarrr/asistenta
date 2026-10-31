import { describe, expect, it } from 'vitest';
import { extractLearnedMarker } from '../src/memory/learned-rules.js';

describe('marca de aprendizaje mal cerrada', () => {
  it('«[[aprendido: … ]» con un solo corchete no sale en la respuesta y se lee', () => {
    const r = extractLearnedMarker('Vale, sin emojis.\n[[aprendido: estilo | Responde sin emojis]');
    expect(r.text).toBe('Vale, sin emojis.');
    expect(r.topic).toBe('estilo');
    expect(r.rule).toBe('Responde sin emojis');
  });

  it('sin cerrar al final de la respuesta', () => {
    const r = extractLearnedMarker('Hecho.\n[[aprendido: tono | Háblame de tú');
    expect(r.text).toBe('Hecho.');
    expect(r.rule).toBe('Háblame de tú');
  });

  it('sin cerrar en medio: solo se quita esa línea', () => {
    const r = extractLearnedMarker('Uno.\n[[aprendido: Respuestas cortas\nDos.');
    expect(r.text).toBe('Uno.\n\nDos.');
    expect(r.rule).toBe('Respuestas cortas');
  });

  it('con un solo corchete al abrir', () => {
    const r = extractLearnedMarker('Ok. [aprendido: estilo | Sin emojis]]');
    expect(r.text).toBe('Ok.');
    expect(r.rule).toBe('Sin emojis');
  });

  it('la marca bien escrita sigue igual y el resto del texto no se toca', () => {
    const r = extractLearnedMarker('Mira [esto] y [[aprendido: estilo | Sin emojis]] ya.');
    expect(r.text).toBe('Mira [esto] y  ya.');
    expect(r.rule).toBe('Sin emojis');
  });
});
