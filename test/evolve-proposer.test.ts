import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { applyEdits, extractJson, safePath } from '../scripts/evolve-proposer.mjs';

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prop-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 1;\n');
  return dir;
}

describe('evolve-proposer', () => {
  it('extrae el JSON aunque venga con valla y charla', () => {
    expect(extractJson('claro:\n```json\n{"files":["src/a.ts"]}\n```\nlisto')).toEqual({
      files: ['src/a.ts'],
    });
    expect(() => extractJson('sin json')).toThrow();
  });

  it('solo permite rutas relativas bajo src/ (test/ no)', () => {
    const d = tree();
    expect(safePath(d, 'src/a.ts')?.rel).toBe('src/a.ts');
    for (const bad of [
      '../x.ts',
      'src/../../x',
      '/etc/passwd',
      'package.json',
      '.git/config',
      'scripts/x.mjs',
      '',
    ]) {
      expect(safePath(d, bad)).toBeNull();
    }
  });

  it('aplica ediciones exactas y únicas', () => {
    const d = tree();
    const n = applyEdits(d, [{ file: 'src/a.ts', search: 'a = 1', replace: 'a = 2' }]);
    expect(n).toBe(1);
    expect(readFileSync(join(d, 'src', 'a.ts'), 'utf8')).toContain('a = 2');
  });

  it('no escribe nada si una edición falla (ambigua, inexistente o fuera de ruta)', () => {
    const d = tree();
    const before = readFileSync(join(d, 'src', 'a.ts'), 'utf8');
    expect(() =>
      applyEdits(d, [
        { file: 'src/a.ts', search: 'a = 1', replace: 'a = 9' },
        { file: 'src/a.ts', search: 'export const', replace: 'const' },
      ]),
    ).toThrow(/ambiguo/);
    expect(() => applyEdits(d, [{ file: 'src/a.ts', search: 'zzz', replace: 'y' }])).toThrow(
      /no existe/,
    );
    expect(() => applyEdits(d, [{ file: 'package.json', search: 'a', replace: 'b' }])).toThrow(
      /ruta/,
    );
    expect(() => applyEdits(d, [])).toThrow();
    expect(readFileSync(join(d, 'src', 'a.ts'), 'utf8')).toBe(before);
  });
});
