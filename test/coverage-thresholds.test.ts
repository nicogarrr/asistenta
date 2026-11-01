import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Trinquete de cobertura: los umbrales de vitest.config.ts solo suben. Medido en CI (job
// `check`, main 44dca1a, 30-oct 20:54Z): líneas/sentencias 83,17 %, ramas 84,90 %, funciones 86,24 %. Los umbrales
// quedan al menos 1 punto por debajo para que una PR normal no se ponga roja por décimas (ramas sigue en 84).
const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
const thresholds = (): Record<string, number> => {
  const m = config.match(/thresholds:\s*\{([^}]*)\}/);
  expect(m, 'vitest.config.ts sin coverage.thresholds').not.toBeNull();
  return Object.fromEntries(
    [...(m?.[1] ?? '').matchAll(/(\w+):\s*(\d+(?:\.\d+)?)/g)].map(([, k, v]) => [k, Number(v)]),
  );
};

describe('umbrales de cobertura', () => {
  it('no bajan de lo medido en CI (82 líneas/sentencias, 84 ramas, 85 funciones)', () => {
    const t = thresholds();
    expect(t.lines).toBeGreaterThanOrEqual(82);
    expect(t.statements).toBeGreaterThanOrEqual(82);
    expect(t.branches).toBeGreaterThanOrEqual(84);
    expect(t.functions).toBeGreaterThanOrEqual(85);
  });
});
