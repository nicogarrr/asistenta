import { describe, expect, it } from 'vitest';
import { detectMemoryWorthy } from '../src/memory/nudges.js';

describe('nudges: límites de palabra con letras acentuadas', () => {
  it('«qué …» / «por qué …» sin interrogación es una pregunta, no un dato', () => {
    expect(detectMemoryWorthy('qué opinas de que siempre llego tarde').worth).toBe(false);
    expect(detectMemoryWorthy('por qué nunca me avisas de los correos').worth).toBe(false);
  });

  it('una palabra que sigue con «ñ» o «á» no cuenta como el disparador', () => {
    expect(detectMemoryWorthy('poco a poco voy añadiendo cosas al carrito').worth).toBe(false);
    expect(detectMemoryWorthy('la tienda que odioñ no existe, era broma').worth).toBe(false);
  });

  it('los disparadores normales siguen funcionando', () => {
    expect(detectMemoryWorthy('siempre llego tarde a las reuniones').worth).toBe(true);
    expect(detectMemoryWorthy('mi café es solo y sin azúcar').worth).toBe(true);
    expect(detectMemoryWorthy('quién sabe, prefiero el té verde').worth).toBe(true);
    expect(detectMemoryWorthy('he decidido que voy a correr cada mañana').worth).toBe(true);
  });
});
