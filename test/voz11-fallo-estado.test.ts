import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { friendlyError } from '../src/channels/formatters.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
describe('fallos internos y el modelo elegido sin mandar a /estado ni a /modelo', () => {
  it('un fallo interno ya no dice «mira /estado»', () => {
    const bug = friendlyError(new TypeError("Cannot read properties of undefined (reading 'x')"));
    expect(bug).toBe(
      'Se me ha roto algo por dentro y no he podido terminar. Vuelve a intentarlo en un momento.',
    );
    const raro = friendlyError(new Error('{"x":1} at foo.js:12'));
    expect(raro).toBe(
      'Algo ha fallado y no he podido terminar. Vuelve a intentarlo en un momento.',
    );
  });

  it('el estado y el borrado nombran el modelo sin el comando', () => {
    const status = readFileSync(new URL('../src/status.ts', import.meta.url), 'utf8');
    const erase = readFileSync(new URL('../src/erase-command.ts', import.meta.url), 'utf8');
    expect(status).toContain("' (el que elegiste)'");
    expect(status).not.toContain("'(elegido con /modelo)'");
    expect(erase).toContain("extras.push('el modelo que elegiste')");
  });
});
