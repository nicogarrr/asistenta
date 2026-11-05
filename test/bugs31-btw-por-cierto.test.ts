import { describe, expect, it } from 'vitest';
import { btwFromText } from '../src/btw.js';

describe('«por cierto, ¿…?» es una pregunta al margen, como «btw»', () => {
  it('se contesta al momento', () => {
    expect(btwFromText('por cierto, ¿qué hora es en Tokio?')).toBe('¿qué hora es en Tokio?');
    expect(btwFromText('Por cierto ¿cuánto queda para el viernes?')).toBe(
      '¿cuánto queda para el viernes?',
    );
  });
  it('lo que pide algo a la tarea no se saca al margen', () => {
    expect(btwFromText('por cierto, ¿puedes mandárselo también a Ana?')).toBeNull();
    expect(btwFromText('por cierto, ¿y si usas el otro fichero?')).toBeNull();
    expect(btwFromText('por cierto usa el otro fichero')).toBeNull();
    expect(btwFromText('btw ¿puedes decirme la hora?')).toBe('¿puedes decirme la hora?');
  });
});
