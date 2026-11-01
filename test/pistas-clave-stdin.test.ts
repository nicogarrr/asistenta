import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Una clave o contraseña nunca se escribe en la línea de la consola: quedaría en el
// historial. Cualquier pista que nombre un secreto manda a `pa vault set-stdin`.
const root = join(import.meta.dirname, '..');
const dirs = ['src', 'docs', 'scripts'];
const sueltos = ['README.md', 'instalar.bat', 'levantar.bat'];
const secreto = /pa vault set (?!-stdin)(\S*(password|key|token|secret)|\$\{)/i;

function ficheros(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...ficheros(p));
    else if (/\.(ts|mjs|md|bat|cmd|ps1)$/.test(n)) out.push(p);
  }
  return out;
}

describe('pistas de claves secretas', () => {
  it('ninguna pista manda a escribir un secreto con pa vault set <nombre> <valor>', () => {
    const malos: string[] = [];
    const todos = [
      ...dirs.flatMap((d) => ficheros(join(root, d))),
      ...sueltos
        .map((s) => join(root, s))
        .filter((p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        }),
    ];
    for (const f of todos) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (secreto.test(l)) malos.push(`${f.slice(root.length + 1)}:${i + 1}`);
        });
    }
    expect(malos).toEqual([]);
  });

  it('la regla distingue set-stdin y valores que no son secretos', () => {
    expect(secreto.test('pa vault set-stdin provider:apiKey')).toBe(false);
    expect(secreto.test('pa vault set telegram:allowedUserIds 123')).toBe(false);
    expect(secreto.test('pa vault set provider:apiKey <key>')).toBe(true);
    expect(secreto.test(`pa vault set ${'$'}{clave} <valor>`)).toBe(true);
  });
});
