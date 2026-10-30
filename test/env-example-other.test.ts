import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Lo mismo que env-example.test.ts para las variables SIN prefijo PA_: claves
 * de proveedor, browserd, vigilante de precios, libros… Si el código lee
 * process.env.X, .env.example tiene que decir que existe. Las del sistema
 * (Windows, PATH, NO_COLOR) no son configuración de Asistenta.
 */
const SYSTEM = new Set([
  'PATH',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'NO_COLOR',
  'HOME',
  'TEMP',
  'TMP',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mts|js)$/.test(name) ? [p] : [];
  });
}

function envReads(text: string): Set<string> {
  const re = /\bprocess\.env(?:\.([A-Z][A-Z0-9_]*)(?![\w$])|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;
  return new Set([...text.matchAll(re)].map((m) => m[1] ?? m[2] ?? ''));
}

const root = join(import.meta.dirname, '..');
const example = readFileSync(join(root, '.env.example'), 'utf8');
const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

describe('.env.example (variables sin PA_)', () => {
  it('reconoce process.env.X y process.env["X"]', () => {
    expect([...envReads(`process.env.FOO_BAR ?? process.env['BAZ']`)]).toEqual(['FOO_BAR', 'BAZ']);
    // process.env.SystemRoot (Windows) no es «S».
    expect([...envReads('process.env.SystemRoot')]).toEqual([]);
  });

  it('documenta toda variable que lee el código', () => {
    const used = new Set<string>();
    for (const f of files(join(root, 'src')))
      for (const v of envReads(readFileSync(f, 'utf8'))) used.add(v);
    const missing = [...used]
      .filter((v) => !v.startsWith('PA_') && !SYSTEM.has(v) && !documented.has(v))
      .sort();
    expect(missing, 'añade una línea comentada al final de .env.example').toEqual([]);
  });
});
