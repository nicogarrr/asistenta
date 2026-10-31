import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (31 oct): que Asistenta hable como en un chat, en castellano bien escrito.
// Varias respuestas que llegan al chat iban sin tildes («camara», «microfono»,
// «esta desactivada», «conexion»).
const cli = readFileSync('src/cli.ts', 'utf8');
const media = readFileSync('src/screen/media.ts', 'utf8');

describe('textos fijos sin jerga (13): tildes en el chat', () => {
  it('cámara y micrófono con tilde en lo que se dice al grabar', () => {
    expect(cli).toContain('Esto veo por la cámara ahora mismo.');
    expect(cli).toContain('s de cámara...`');
    expect(cli).toContain('s por el micrófono...`');
    expect(cli).toContain('en el micrófono. Dime');
    expect(cli).not.toMatch(
      /de camara\.\.\.|por la camara|por el microfono\.\.\.|en el microfono\. Dime/,
    );
  });

  it('investigación amplia y conexión con Telegram bien escritas', () => {
    expect(cli).toContain('La investigación amplia está desactivada');
    expect(cli).toContain('Actívala con PA_INVESTIGA_AMPLIO=1');
    expect(cli).toContain('He perdido la conexión con Telegram:');
    expect(cli).not.toContain('investigacion amplia esta desactivada');
  });

  it('sin cámara o sin micrófono: el aviso va con tildes', () => {
    expect(media).not.toMatch(/ninguna camara|ningun microfono/);
    expect(media).toContain('no encuentro ninguna cámara en este ordenador.');
    expect(media).toContain('no encuentro ningún micrófono en este ordenador.');
  });
});
