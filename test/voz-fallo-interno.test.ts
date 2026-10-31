import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plainVoiceError } from '../src/voice/plain-error.js';

// Nico (31 oct): que Asistenta hable como en un chat. Cuando algo falla por dentro
// no hace falta hablarle del «registro»: basta con decir que el fallo es nuestro.
const routine = readFileSync('src/daemon/routine-fire.ts', 'utf8');
const formatters = readFileSync('src/channels/formatters.ts', 'utf8');

describe('fallos internos sin «registro»', () => {
  it('voz: un fallo sin detalle dice «algo ha fallado por mi parte»', () => {
    expect(plainVoiceError(new Error(''))).toBe('algo ha fallado por mi parte');
    expect(plainVoiceError(new Error('boom\n    at foo (x.js:1:1)'))).toBe(
      'algo ha fallado por mi parte',
    );
  });

  it('rutina que no arranca por un fallo raro: misma frase', () => {
    expect(routine).toContain("return 'algo ha fallado por mi parte';");
    expect(routine).not.toContain('el detalle está en el registro');
  });

  it('chat: los avisos de fallo no hablan del registro', () => {
    expect(formatters).not.toContain('Queda apuntado en el registro');
    expect(formatters).toContain('no he podido terminar. Prueba otra vez o mira /estado.');
  });
});
