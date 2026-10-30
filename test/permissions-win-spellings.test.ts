import { describe, expect, it } from 'vitest';
import { lexicalNormalize } from '../src/permissions.js';

/**
 * El daemon corre en Windows: el mismo fichero admite otras grafías (puntos o espacios
 * finales, flujos «::$DATA», prefijo \\?\). La comparación con las rutas protegidas
 * y los secretos debía verlas como el mismo fichero.
 */
describe('lexicalNormalize: grafías de Windows del mismo fichero', () => {
  const base = lexicalNormalize('C:\\Repo\\src\\cli.ts');
  it.each([
    'C:\\Repo\\src\\cli.ts.',
    'C:\\Repo\\src\\cli.ts. .',
    'C:\\Repo\\src\\cli.ts ',
    'C:\\Repo\\src\\cli.ts::$DATA',
    'C:\\Repo\\src\\cli.ts:otro',
    'C:\\Repo.\\src \\cli.ts',
    '\\\\?\\C:\\Repo\\src\\cli.ts',
    '\\\\.\\C:\\Repo\\src\\cli.ts',
  ])('%s es el mismo fichero', (p) => {
    expect(lexicalNormalize(p)).toBe(base);
  });

  it('un .env con flujo o punto final sigue siendo .env', () => {
    expect(lexicalNormalize('C:\\app\\.env::$DATA')).toBe('c:\\app\\.env');
    expect(lexicalNormalize('C:\\app\\.env.')).toBe('c:\\app\\.env');
  });

  it('UNC con prefijo de dispositivo y rutas normales no cambian', () => {
    expect(lexicalNormalize('\\\\?\\UNC\\srv\\share\\a.txt')).toBe(
      lexicalNormalize('\\\\srv\\share\\a.txt'),
    );
    expect(lexicalNormalize('C:\\a\\.\\b\\..\\c.txt')).toBe('c:\\a\\c.txt');
    expect(lexicalNormalize('/home/u/x.md')).toBe('home\\u\\x.md');
  });
});
