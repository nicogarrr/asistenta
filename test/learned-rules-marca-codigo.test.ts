import { describe, expect, it } from 'vitest';
import { extractLearnedMarker } from '../src/memory/learned-rules.js';

describe('marca de aprendizaje entre comillas de código', () => {
  it('«`[[aprendido: … ]]`» no deja «``» en la respuesta', () => {
    const r = extractLearnedMarker(
      'Vale, más corto.\n\n`[[aprendido: estilo | Respuestas cortas]]`',
    );
    expect(r.text).toBe('Vale, más corto.');
    expect(r.rule).toBe('Respuestas cortas');
  });

  it('con triple comilla o en negrita tampoco queda nada', () => {
    expect(extractLearnedMarker('Hecho. ```[[aprendido: tono | Háblame de tú]]```').text).toBe(
      'Hecho.',
    );
    expect(extractLearnedMarker('Hecho. **[[aprendido: tono | Háblame de tú]]**').text).toBe(
      'Hecho.',
    );
  });

  it('el código de verdad de la respuesta no se toca', () => {
    const r = extractLearnedMarker('Usa `npm test`.\n[[aprendido: a | Sin emojis]]');
    expect(r.text).toBe('Usa `npm test`.');
  });
});
