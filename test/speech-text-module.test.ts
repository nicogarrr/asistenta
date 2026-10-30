import { describe, expect, it } from 'vitest';
import * as cli from '../src/cli.js';
import * as speech from '../src/daemon/speech-text.js';

// P2 (ARCHITECTURE.md): trimForSpeech lives in src/daemon/speech-text.ts; cli.ts
// re-exports the very same function, so every existing import keeps working.
describe('speech-text module', () => {
  it('cli.ts re-exports the same function (pure move)', () => {
    expect(typeof speech.trimForSpeech).toBe('function');
    expect(cli.trimForSpeech).toBe(speech.trimForSpeech);
  });

  it('behaves as before: markdown out, cut at a sentence end', () => {
    expect(speech.trimForSpeech('**Hola** [web](https://x.com) ✅')).toBe('Hola web');
    const out = speech.trimForSpeech('Una frase corta de prueba. '.repeat(60));
    expect(out.length).toBeLessThanOrEqual(903);
    expect(out.endsWith('....')).toBe(true);
  });
});
