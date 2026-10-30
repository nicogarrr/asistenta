import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Trinquete de cobertura: los umbrales de vitest.config.ts solo suben. Medido en CI (job
// `check`, main + #756, 30-oct): líneas 81,76 %, ramas 84,31 %, funciones 85,06 %. Los umbrales
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
  it('no bajan de lo medido en CI (80 líneas/sentencias, 83 ramas, 84 funciones)', () => {
    const t = thresholds();
    expect(t.lines).toBeGreaterThanOrEqual(80);
    expect(t.statements).toBeGreaterThanOrEqual(80);
    expect(t.branches).toBeGreaterThanOrEqual(83);
    expect(t.functions).toBeGreaterThanOrEqual(84);
  });
});
