import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Nico (31 oct): que Asistenta hable claro. Los avisos de `pa setup` salen tal cual
// en la consola, así que no deben llevar jerga interna.
const JERGA =
  /\bdaemon\b|\bsetup\b|\bwizard\b|\bflock\b|\bPID\b|\bstale\b|metadata|propiedad de|almacén/i;

function mensajes(file: string): string[] {
  const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  return [...src.matchAll(/new Error\(\s*'([^']+)'/g)].map((m) => m[1] as string);
}

describe('avisos de pa setup en lenguaje natural', () => {
  const textos = mensajes('setup-ownership.ts');

  it('encuentra los avisos', () => {
    expect(textos.length).toBeGreaterThanOrEqual(8);
  });

  for (const t of textos) {
    it(`sin jerga: ${t.slice(0, 50)}`, () => {
      expect(t).not.toMatch(JERGA);
    });
  }
});
