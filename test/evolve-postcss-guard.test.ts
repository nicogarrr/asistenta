import { describe, expect, it } from 'vitest';
import { isProtectedPath } from '../src/evolve/guard.js';

// vite busca postcss.config.* / .postcssrc* en la raíz al arrancar, aunque ningún test
// importe CSS, y lo ejecuta en el proceso principal de vitest (el que escribe el informe de la
// medición): comprobado con vitest real, 31 oct. Un intento que lo añadiera correría código ahí.
describe('la config de postcss no la toca el bucle', () => {
  for (const f of [
    'postcss.config.cjs',
    'postcss.config.js',
    'postcss.config.mjs',
    'postcss.config.ts',
    '.postcssrc',
    '.postcssrc.json',
    '.postcssrc.cjs',
    'PostCSS.config.cjs',
  ]) {
    it(`${f} es intocable`, () => {
      expect(isProtectedPath(f)).toBe(true);
    });
  }
  it('un fichero normal sigue libre', () => {
    expect(isProtectedPath('src/tools/postcss-notes.ts')).toBe(false);
  });
});
