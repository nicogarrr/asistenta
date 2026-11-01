import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { altavozWords, parseAltavozArgs } from '../src/audio/altavoz.js';
import { unknownCommandText } from '../src/palabras-vigilancia.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const cli = src('cli.ts');

describe('modo altavoz y comandos desconocidos sin mandar a comandos', () => {
  it('el modelo ya no dice «/altavoz pc»: el modo altavoz se pide en palabras', () => {
    expect(src('tools/media.ts')).not.toContain('tell them to send /altavoz');
    expect(src('tools/media.ts')).toContain('«pon el modo');
    expect(altavozWords('pon el modo altavoz')).toBe('pc');
    expect(altavozWords('Activa el modo altavoz en la tele.')).toBe('tele');
    expect(altavozWords('pon el modo altavoz por el ordenador')).toBe('pc');
    expect(altavozWords('quita el modo altavoz')).toBe('off');
    // «pon el altavoz» a secas puede ser «suena esto»: no se toca.
    for (const t of ['pon el altavoz', 'altavoz', 'pon el modo avión', ''])
      expect(altavozWords(t), t).toBeNull();
    for (const t of [
      'pon el modo altavoz',
      'pon el modo altavoz en la tele',
      'quita el modo altavoz',
    ])
      expect(parseAltavozArgs(altavozWords(t) ?? '').kind, t).toBe('set');
    expect(cli).toContain('const altavozMode = altavozWords(inbound.text);');
  });

  it('un «/algo» que no existe no manda a /help', () => {
    expect(unknownCommandText('foo')).toBe(
      'No conozco «/foo». Dime con tus palabras qué quieres y me pongo.',
    );
    expect(cli).not.toContain('/help para ver la lista.');
  });
});
