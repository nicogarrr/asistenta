import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Trinquete de cobertura: los umbrales de vitest.config.ts solo suben. Medido en CI (job
// `check`, main ef119c8, 30-oct 19:56Z): líneas/sentencias 82,71 %, ramas 84,96 %, funciones 85,73 %. Los umbrales
// quedan algo por debajo para que una PR normal no se ponga roja por décimas.
const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
const thresholds = (): Record<string, number> => {
  const m = config.match(/thresholds:\s*\{([^}]*)\}/);
  expect(m, 'vitest.config.ts sin coverage.thresholds').not.toBeNull();
  return Object.fromEntries(
    [...(m?.[1] ?? '').matchAll(/(\w+):\s*(\d+(?:\.\d+)?)/g)].map(([, k, v]) => [k, Number(v)]),
  );
};

describe('umbrales de cobertura', () => {
  it('no bajan de lo medido en CI (81 líneas/sentencias, 84 ramas, 84 funciones)', () => {
    const t = thresholds();
    expect(t.lines).toBeGreaterThanOrEqual(81);
    expect(t.statements).toBeGreaterThanOrEqual(81);
    expect(t.branches).toBeGreaterThanOrEqual(84);
    expect(t.functions).toBeGreaterThanOrEqual(84);
  });
});
