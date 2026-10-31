import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { setupCommand } from '../src/setup.js';

// En Windows `pa setup` no cambia nada: debe llevar al instalador de un paso,
// no a una guía que no existe.
it('pa setup en Windows lleva a instalar.bat sin tocar nada', async () => {
  let out = '';
  const touched = vi.fn();
  const code = await setupCommand([], {
    platform: 'win32',
    write: (s: string) => {
      out += s;
    },
    inspect: touched,
    acquire: touched,
    configure: touched,
    question: touched,
  } as never);
  expect(code).toBe(2);
  expect(touched).not.toHaveBeenCalled();
  expect(out).toContain('instalar.bat');
  expect(out).toContain('no he tocado nada');
  expect(out).not.toContain('mutex/DACL');
});

it('docs/windows-startup.md dice que instalar.bat prepara los requisitos', () => {
  const doc = readFileSync(new URL('../docs/windows-startup.md', import.meta.url), 'utf8');
  expect(doc).toContain('`instalar.bat` deja ambas cosas listas');
});
