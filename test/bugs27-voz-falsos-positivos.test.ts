import { describe, expect, it } from 'vitest';
import { pideVoz } from '../src/daemon/voice-ask.js';

describe('pideVoz: frases normales ya no piden la respuesta en audio', () => {
  it.each([
    'ponme una canción con voz femenina',
    '¿controlas la tele por voz?',
    'busca un vídeo con audio en español',
    'háblame de la historia de Roma',
    'háblame sobre el plan de mañana',
    'yo manejo las cuentas de la casa',
    'conduzco un Seat Ibiza, ¿qué seguro me conviene?',
    'estoy manejando el Excel de gastos',
    'el curso viene con voz en off',
  ])('no pide voz: %s', (t) => expect(pideVoz(t)).toBe(false));

  it.each([
    'mándamelo en un audio',
    'explícamelo en audio',
    'contesta con voz',
    'respóndeme por nota de voz',
    'háblame',
    'háblame, que estoy cocinando',
    'conduzco',
    'manejo ahora, dime el tráfico',
    'estoy manejando, ¿qué tengo hoy?',
    'voy conduciendo, dime qué hay hoy',
    'léemelo en voz alta',
  ])('pide voz: %s', (t) => expect(pideVoz(t)).toBe(true));
});
