import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// `npm ci` falla con ERESOLVE si un paquete @vitest/* no va a la misma versión exacta
// que vitest (sus peerDependencies piden la versión idéntica). Pasó al subir vitest
// a 3.2.7 con @vitest/coverage-v8 aún en 3.2.4: CI y todas las instalaciones limpias rotas.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('dependencias de test coherentes', () => {
  it('todo @vitest/* va a la misma versión exacta que vitest', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    const vitest = all.vitest;
    expect(vitest).toMatch(/^\d+\.\d+\.\d+$/);
    const companions = Object.entries(all).filter(([name]) => name.startsWith('@vitest/'));
    expect(companions.length).toBeGreaterThan(0);
    for (const [name, version] of companions) {
      expect({ name, version }).toEqual({ name, version: vitest });
    }
  });
});
