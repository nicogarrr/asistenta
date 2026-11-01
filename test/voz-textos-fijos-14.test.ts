import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captureFailureMessage } from '../src/voice/wake.js';

// Nico (31 oct): que Asistenta hable como en un chat, en castellano llano.
// Los fallos del micrófono de la palabra de activación llegaban al chat sin
// tildes y con la cola en inglés de ffmpeg («(ffmpeg salio con 1): Could not
// enumerate audio only devices…»).
const wake = readFileSync('src/voice/wake.ts', 'utf8');
const telegram = readFileSync('src/channels/telegram.ts', 'utf8');

describe('textos fijos sin jerga (14): micrófono de la palabra de activación', () => {
  it('micrófono ocupado: con tildes y sin «reintentos automaticos»', () => {
    const msg = captureFailureMessage(
      'Micrófono (Realtek)',
      1,
      '[dshow] Error opening input: 0x800700aa resource is in use',
    );
    expect(msg).toBe(
      'el micrófono «Micrófono (Realtek)» está ocupado por otro programa (¿una llamada o una grabación?); no lo reintento solo',
    );
  });

  it('otro fallo: frase llana, sin el texto de ffmpeg ni su código de salida', () => {
    const msg = captureFailureMessage(
      'Micrófono (Realtek)',
      1,
      'Could not enumerate audio only devices (or none found).\nError opening input file audio=x.',
    );
    expect(msg).not.toMatch(/ffmpeg|salio|Could not|enumerate|Error opening/);
    expect(msg).toContain('no puedo usar el micrófono «Micrófono (Realtek)»');
    expect(msg).toContain('Privacidad > Micrófono');
  });

  it('sin micrófono, sin ffmpeg o sin arrancar: con tildes y sin el error crudo', () => {
    expect(wake).toContain('no encuentro ningún micrófono en este ordenador.');
    expect(wake).toContain(
      'no puedo usar el micrófono: no arranca el programa que graba el audio.',
    );
    expect(wake).not.toMatch(/ningun microfono|del microfono: \$\{err\.message\}|esta ocupado/);
  });

  it('el pie de la nota de voz en Telegram lleva tilde', () => {
    expect(telegram).toContain('s de micrófono`');
    expect(telegram).not.toContain('s de microfono`');
  });
});
