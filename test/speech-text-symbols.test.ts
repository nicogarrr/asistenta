import { describe, expect, it } from 'vitest';
import { trimForSpeech } from '../src/cli.js';

// SAPI lee los símbolos de texto por su nombre: «Madrid → Bilbao» sonaba
// «Madrid flecha a la derecha Bilbao» y «★★★★☆» eran cinco «estrella negra».
describe('trimForSpeech: símbolos de texto que no son emoji', () => {
  it('las flechas son una pausa, no «flecha a la derecha»', () => {
    expect(trimForSpeech('Madrid → Bilbao')).toBe('Madrid, Bilbao');
    expect(trimForSpeech('Paso 1 -> paso 2 => listo')).toBe('Paso 1, paso 2, listo');
    expect(trimForSpeech('Precio ⇒ 45 €')).toBe('Precio, 45 €');
  });

  it('estrellas, marcas y cajas desaparecen', () => {
    expect(trimForSpeech('Valoración ★★★★☆ en Google')).toBe('Valoración en Google');
    expect(trimForSpeech('✓ Hecho ✗ Pendiente')).toBe('Hecho Pendiente');
    expect(trimForSpeech('■ Primero ● Segundo ▪ Tercero')).toBe('Primero Segundo Tercero');
  });

  it('el texto normal, los números y el euro se quedan', () => {
    expect(trimForSpeech('Son 1.500 € a las 10:30, -5 grados.')).toBe(
      'Son 1.500 € a las 10:30, -5 grados.',
    );
    expect(trimForSpeech('a < b y c > d')).toBe('a < b y c d');
  });
});
