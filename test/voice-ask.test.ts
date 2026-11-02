import { describe, expect, it } from 'vitest';
import { pideVoz } from '../src/daemon/voice-ask.js';

describe('pideVoz', () => {
  it.each([
    'mándamelo en un audio',
    'contéstame con voz',
    'respóndeme en una nota de voz',
    'estoy conduciendo, dime qué hay hoy',
    'voy conduciendo',
    'léemelo en voz alta',
    'cuéntamelo hablando',
  ])('pide voz: %s', (t) => expect(pideVoz(t)).toBe(true));
  it.each([
    '[nota de voz] ¿qué tiempo hace?',
    'abre el correo y resume lo nuevo',
    'busca un audio de Spotify',
    'sin audio por favor, no me mandes audio',
    'no me contestes con voz',
    '',
  ])('no pide voz: %s', (t) => expect(pideVoz(t)).toBe(false));
});
